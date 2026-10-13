/**
 * figma-diff capture engine
 *
 * For each page x breakpoint defined in config.json:
 *   - obtains the Figma frame (see "Figma source" below)
 *   - screenshots the localhost page at the breakpoint width with Playwright
 * Writes output/<page>/<bp>-figma.png, <bp>-impl.png and output/manifest.json
 *
 * Figma source (config.figmaSource / page.figmaSource / --source=, default "auto"):
 *   - "rest" : Figma REST /v1/images only
 *   - "mcp"  : skip REST; queue frames into output/figma-needed.json for the MCP
 *              (the Figma MCP isn't reachable from a node process, so a Claude/MCP
 *               step fulfils the queue, then re-run with --no-figma)
 *   - "auto" : try REST, and queue any frame that fails (e.g. 429) for the MCP
 *
 * Usage: node figma-diff/capture.js [pageName] [--source=auto|rest|mcp]
 *                                   [--refresh-figma] [--no-figma]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUTPUT = path.join(ROOT, 'output');

// --- tiny .env loader (avoids adding a dependency) ---
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// --- config loading ---
// Distinguishes the three ways config.json goes wrong (absent / unparseable /
// structurally invalid), because the fix differs for each. config.json is
// gitignored, so "absent" is the normal state of a fresh clone.
function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      'config.json not found in figma-diff/.\n'
      + '  Create it either way:\n'
      + '    npm run ui                            # control panel, adds pages for you\n'
      + '    cp config.example.json config.json    # then edit by hand'
    );
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON (${err.message})\n  Fix or recreate it: ${file}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`config.json must contain a JSON object. See config.example.json.`);
  }
  if (!Array.isArray(config.pages)) {
    throw new Error(
      'config.json has no "pages" array. Add pages via `npm run ui`, or copy the shape '
      + 'from config.example.json / the README.'
    );
  }
  return config;
}

// Check every page up front, before the browser starts — a page missing its
// "figma" block used to crash mid-run, after earlier pages had been captured.
// Collects all problems so one pass over the config fixes them all.
function validatePages(pages, config, { needFileKey }) {
  const problems = [];
  pages.forEach((p, i) => {
    const label = p && p.name ? `page "${p.name}"` : `page #${i + 1}`;
    if (!p || typeof p !== 'object') { problems.push(`${label}: not an object`); return; }
    if (!p.name) problems.push(`${label}: missing "name"`);
    if (!p.url) problems.push(`${label}: missing "url" (e.g. "http://localhost:3000/order-now")`);
    const ids = p.figma && typeof p.figma === 'object' ? Object.values(p.figma).filter(Boolean) : [];
    if (!ids.length) {
      problems.push(`${label}: missing "figma" node ids, e.g. "figma": { "375": "3305:23904" }`);
    } else if (needFileKey && !(p.figmaFileKey || config.figmaFileKey)) {
      problems.push(`${label}: no "figmaFileKey" — set it globally in config.json or on this page`);
    }
  });
  if (problems.length) {
    throw new Error(`config.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }
}

// --- Figma REST: render a single node id -> PNG url ---
// Requests one frame at a time (batching large frames triggers render timeouts).
// On a render timeout, retries and steps the scale down so big frames still render.
// Only transient failures are retried: a 429 or an auth/not-found status is final,
// and retrying a 429 only extends the lockout (the /v1/images bucket has a
// multi-hour reset).
async function figmaImageUrl(fileKey, id, scale, token, attempts = 4) {
  let s = scale;
  let lastErr = '';
  for (let i = 1; i <= attempts; i++) {
    const url = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(id)}&format=png&scale=${s}`;
    const res = await fetch(url, { headers: { 'X-Figma-Token': token } });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_) { /* non-JSON error body */ }

    if (res.ok && !json.err && json.images && json.images[id]) {
      return { url: json.images[id], scale: s };
    }

    if (res.status === 429) {
      const secs = parseInt(res.headers.get('retry-after') || '', 10);
      const human = Number.isFinite(secs) ? ` retry in ~${(secs / 3600).toFixed(1)}h` : '';
      const link = res.headers.get('x-figma-upgrade-link');
      throw new Error(`Figma rate limit (429) on /v1/images.${human}${link ? ` Upgrade: ${link}` : ''}`);
    }

    // Auth / visibility failures never recover by retrying, and Figma reports all
    // of them as 403 "Invalid token" — including a file key the token can't see —
    // so name both causes rather than sending you to the wrong file.
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Figma auth failed (${res.status}: ${json.err || text.slice(0, 80)}). Either FIGMA_TOKEN in `
        + `figma-diff/.env is wrong/expired, or it can't access file "${fileKey}". The token needs `
        + 'the "File content: read" scope and access to that file.'
      );
    }
    if (res.status === 404) {
      throw new Error(`Figma file "${fileKey}" not found (404). Check figmaFileKey in config.json.`);
    }

    lastErr = `${res.status}: ${json.err || text}`;
    const isTimeout = /timeout/i.test(text);
    if (i === attempts) break;
    if (isTimeout && s > 1) s = Math.max(1, s - 1); // shrink to beat the render timeout
    console.log(`    figma render retry ${i}/${attempts - 1} (${isTimeout ? 'render timeout' : 'status ' + res.status}, scale ${s})`);
    await new Promise((r) => setTimeout(r, 2000 + i * 1000));
  }
  throw new Error(`Figma API ${lastErr}`);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

// Write via a temp file + rename so an interrupted run can't leave a truncated
// manifest behind for report.js to choke on.
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// MCP get_screenshot renders at native resolution and only ever downscales to fit
// maxDimension, so the queue asks for the maximum (65536) — that guarantees full
// native resolution for any frame without needing to know its height up front.
const MCP_MAX_DIMENSION = 65536;

// ensure lazyload images are loaded: scroll to trip IntersectionObserver-based
// loaders, force any remaining data-src images, then wait for all images to settle
async function triggerLazyLoad(page) {
  // 1) scroll through the page to trigger viewport-based lazy loaders
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        if (y >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 80);
    });
  });

  // 2) force any image still holding a data-src / data-srcset to load eagerly
  await page.evaluate(() => {
    document.querySelectorAll('img[data-src], img[data-srcset]').forEach((img) => {
      if (img.dataset.srcset) img.srcset = img.dataset.srcset;
      if (img.dataset.src) img.src = img.dataset.src;
      img.loading = 'eager';
      img.classList.add('lazyloaded');
      img.classList.remove('lazyload');
    });
  });

  // 3) wait for every image to finish decoding (capped at 20s)
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        [...document.images].map((img) =>
          img.complete && img.naturalWidth > 0
            ? null
            : new Promise((res) => {
                img.addEventListener('load', res, { once: true });
                img.addEventListener('error', res, { once: true });
              })
        )
      ),
      new Promise((res) => setTimeout(res, 20000)),
    ])
  );
  await page.waitForTimeout(300);
}

// navigate with retries so a transient dev-server reload doesn't fail the run
async function gotoWithRetry(page, url, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`    goto retry ${i}/${attempts - 1} (${err.message.split('\n')[0]})`);
      await page.waitForTimeout(2000);
    }
  }
}

async function main() {
  loadEnv();
  const config = loadConfig();
  const args = process.argv.slice(2);
  const refreshFigma = args.includes('--refresh-figma');
  const noFigma = args.includes('--no-figma'); // cache-only: never call the API
  const cliSource = (args.find((a) => a.startsWith('--source=')) || '').split('=')[1];
  const validSources = ['auto', 'rest', 'mcp'];
  if (cliSource && !validSources.includes(cliSource)) {
    throw new Error(`--source=${cliSource} is not valid. Use one of: ${validSources.join(', ')}`);
  }
  // auto-fulfil the MCP queue via `claude -p` (config.autoFulfillMcp, default on)
  const autoMcp = args.includes('--auto-mcp')
    || (config.autoFulfillMcp !== false && !args.includes('--no-auto-mcp'));
  const onlyPage = args.find((a) => !a.startsWith('--'));
  const pages = onlyPage ? config.pages.filter((p) => p.name === onlyPage) : config.pages;
  if (!pages.length) {
    const known = config.pages.map((p) => p && p.name).filter(Boolean);
    throw new Error(onlyPage
      ? `No page "${onlyPage}" in config.json.${known.length ? ` Known pages: ${known.join(', ')}` : ''}`
      : 'config.json has no pages yet. Add one with `npm run ui`.');
  }
  validatePages(pages, config, { needFileKey: !noFigma });

  // The token is only needed for REST. A cache-only or MCP-only run doesn't touch
  // /v1/images, so don't block it on a token it will never send.
  const restPossible = !noFigma
    && pages.some((p) => (cliSource || p.figmaSource || config.figmaSource || 'auto') !== 'mcp');
  const token = process.env.FIGMA_TOKEN;
  if (!token && restPossible) {
    throw new Error(
      'FIGMA_TOKEN missing (expected in figma-diff/.env).\n'
      + '  cp .env.example .env   # then paste a token with the "File content: read" scope\n'
      + '  Or avoid REST entirely: --source=mcp (render via the Figma MCP), or --no-figma (cached frames only).'
    );
  }

  const scale = config.scale || 2;
  const breakpoints = config.breakpoints || [375, 768, 1920];

  const browser = await chromium.launch();
  const manifest = { generatedAt: new Date().toISOString(), scale, pages: [] };
  const needed = []; // frames to be fulfilled via the Figma MCP

  try {
    for (const pageDef of pages) {
      console.log(`\n=== ${pageDef.name} ===`);
      const pageDir = path.join(OUTPUT, pageDef.name);
      fs.mkdirSync(pageDir, { recursive: true });

      const fileKey = pageDef.figmaFileKey || config.figmaFileKey;
      const source = cliSource || pageDef.figmaSource || config.figmaSource || 'auto';
      const dismiss = pageDef.dismiss || config.dismiss || []; // selectors to hide before capture
      const entry = { name: pageDef.name, url: pageDef.url, breakpoints: [] };

      for (const bp of breakpoints) {
        const nodeId = pageDef.figma[String(bp)];
        const figmaFile = `${bp}-figma.png`;
        const implFile = `${bp}-impl.png`;
        const figmaPath = path.join(pageDir, figmaFile);
        let figmaOk = false;

        // queue a frame for the Figma MCP step (full native resolution)
        const queueForMcp = (reason) => {
          needed.push({
            page: pageDef.name, width: bp, fileKey, nodeId,
            out: `${pageDef.name}/${figmaFile}`, maxDimension: MCP_MAX_DIMENSION,
          });
          figmaOk = fs.existsSync(figmaPath);
          console.log(`  [${bp}] figma  queued for MCP (${reason})${figmaOk ? ', using cached for now' : ''}`);
        };

        // Figma side: cache-first. A cached frame is reused unless --refresh-figma,
        // so normal iteration never touches the rate-limited /v1/images endpoint.
        if (!nodeId) {
          console.log(`  [${bp}] figma  SKIPPED (no node id)`);
        } else if ((fs.existsSync(figmaPath) && !refreshFigma) || noFigma) {
          figmaOk = fs.existsSync(figmaPath);
          console.log(`  [${bp}] figma  ${figmaOk ? 'cached' : 'skipped (--no-figma, not cached)'}`);
        } else if (source === 'mcp') {
          await queueForMcp('source=mcp');
        } else {
          // "rest" or "auto"
          try {
            const { url, scale: usedScale } = await figmaImageUrl(fileKey, nodeId, scale, token);
            await download(url, figmaPath);
            figmaOk = true;
            console.log(`  [${bp}] figma  ok${usedScale !== scale ? ` (scaled to ${usedScale}x)` : ''}`);
          } catch (err) {
            if (source === 'auto') {
              await queueForMcp(err.message);
            } else {
              // source === "rest": don't fall back, keep any stale cache
              figmaOk = fs.existsSync(figmaPath);
              console.log(`  [${bp}] figma  FAILED${figmaOk ? ' (using cached)' : ''} — ${err.message}`);
            }
          }
        }

        // Implementation side
        const ctx = await browser.newContext({
          viewport: { width: bp, height: 900 },
          deviceScaleFactor: scale,
        });
        const page = await ctx.newPage();
        await gotoWithRetry(page, pageDef.url);
        await triggerLazyLoad(page);
        // hide overlays (cookie bars, popups) that aren't part of the design
        if (dismiss.length) {
          await page.evaluate((sels) => {
            sels.forEach((sel) =>
              document.querySelectorAll(sel).forEach((el) => el.style.setProperty('display', 'none', 'important')));
            // release any scroll-lock those overlays apply
            document.documentElement.style.overflow = '';
            document.body.style.overflow = '';
          }, dismiss);
        }
        await page.screenshot({ path: path.join(pageDir, implFile), fullPage: true, timeout: 120000 });
        await ctx.close();
        console.log(`  [${bp}] impl   ok`);

        entry.breakpoints.push({
          width: bp,
          figma: figmaOk ? `${pageDef.name}/${figmaFile}` : null,
          impl: `${pageDef.name}/${implFile}`,
        });
      }

      manifest.pages.push(entry);
    }
  } finally {
    await browser.close();
  }

  // Merge with any existing manifest so per-page runs accumulate — the report
  // shows every captured page (ordered by config), not just the last one run.
  const manifestPath = path.join(OUTPUT, 'manifest.json');
  const byName = {};
  if (fs.existsSync(manifestPath)) {
    try { (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).pages || []).forEach((p) => { byName[p.name] = p; }); }
    catch (_) { /* ignore malformed manifest */ }
  }
  manifest.pages.forEach((p) => { byName[p.name] = p; }); // this run overrides
  manifest.pages = config.pages.map((p) => byName[p.name]).filter(Boolean);
  writeJsonAtomic(manifestPath, manifest);
  console.log(`\nWrote ${manifestPath}`);

  // Hand off any frames REST couldn't provide to the Figma MCP step.
  const neededPath = path.join(OUTPUT, 'figma-needed.json');
  if (!needed.length) {
    if (fs.existsSync(neededPath)) fs.unlinkSync(neededPath); // clear stale queue
    return;
  }

  writeJsonAtomic(neededPath, { generatedAt: new Date().toISOString(), frames: needed });
  console.log(`\n${needed.length} frame(s) need the Figma MCP -> ${neededPath}`);

  if (!autoMcp) {
    console.log('Next: ask Claude to fulfil figma-needed.json via the Figma MCP, then');
    console.log('      node figma-diff/capture.js --no-figma && node figma-diff/report.js');
    return;
  }

  // auto-fulfil via the headless claude bridge, then patch the manifest with
  // whatever frames now exist on disk so the report comes out complete.
  spawnSync('node', [path.join(ROOT, 'fulfill-figma.js')], { stdio: 'inherit' });
  let patched = 0;
  for (const frame of needed) {
    const abs = path.join(OUTPUT, frame.out);
    if (!fs.existsSync(abs)) continue;
    // sanity-check resolution: width below the breakpoint means the MCP step
    // downscaled the frame (too small a maxDimension)
    try {
      const w = fs.readFileSync(abs).readUInt32BE(16);
      if (w < frame.width) console.log(`  warning: ${frame.out} is ${w}px wide (< ${frame.width}px) — low resolution`);
    } catch (_) { /* ignore */ }
    const pg = manifest.pages.find((p) => p.name === frame.page);
    const bpEntry = pg && pg.breakpoints.find((b) => b.width === frame.width);
    if (bpEntry && !bpEntry.figma) { bpEntry.figma = frame.out; patched++; }
  }
  if (patched) {
    writeJsonAtomic(manifestPath, manifest);
    console.log(`Patched ${patched} fulfilled frame(s) into the manifest.`);
  }
  if (fs.existsSync(neededPath)) {
    console.log('Some frames are still queued — fulfil them and re-run report.js.');
  }
}

main().catch((err) => {
  console.error('\ncapture failed:', err.message);
  process.exit(1);
});
