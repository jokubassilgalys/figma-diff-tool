/**
 * figma-diff report generator
 *
 * Reads output/manifest.json and writes a self-contained output/index.html with,
 * per page x breakpoint, three view modes:
 *   - Side by side (Figma | implementation)
 *   - Overlay (onion-skin: opacity slider + draggable wipe)
 *   - Difference (mix-blend-mode: difference)
 *
 * In side-by-side, either column can be shifted vertically (drag or arrow keys) so a
 * section can be re-synced — otherwise compounding drift makes the bottom of a tall
 * page compare two different places.
 *
 * In overlay/difference modes the implementation layer can be re-anchored: drag it
 * (or arrow-key nudge) to align a specific section, so accumulated vertical drift
 * from a section above doesn't make everything below it read as misaligned. The
 * offset is shown in the page's own CSS pixels.
 *
 * A per-card "Live" toggle swaps the implementation screenshot for a live iframe of
 * the localhost page (so you can iterate without re-capturing). Live only works when
 * the report is opened through the control panel (an iframe -> localhost needs an
 * http origin), and it disables Difference (blend can't cross an iframe boundary).
 *
 * Usage: node figma-diff/report.js
 */
const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, 'output');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pngSize(file) {
  try { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
  catch (_) { return null; }
}

function cardHtml(pageName, pageUrl, bp) {
  const id = `${pageName}-${bp.width}`;
  const hasFigma = !!bp.figma;
  const figmaImg = hasFigma ? `<img class="layer figma" src="${bp.figma}" alt="figma ${bp.width}">` : '';

  // Live iframe is available when we have a page URL and a Figma frame to size against.
  const figDim = hasFigma ? pngSize(path.join(OUTPUT, bp.figma)) : null;
  const canLive = !!(pageUrl && figDim);
  const frame = canLive
    ? `<iframe class="impl-frame" data-src="${esc(pageUrl)}" scrolling="no"></iframe>`
    : '';
  const implImg = `<img class="impl-img" src="${bp.impl}" alt="impl ${bp.width}">`;
  const dataDim = canLive ? ` data-figw="${figDim.w}" data-figh="${figDim.h}"` : '';

  return `
  <section class="card" data-id="${id}" data-page="${esc(pageName)}" data-bp="${bp.width}" data-mode="side"${dataDim}>
    <header>
      <h3>${pageName} · ${bp.width}px${hasFigma ? '' : ' <span class="warn">(no Figma frame)</span>'}</h3>
      <div class="modes">
        <button data-mode="side" class="active">Side by side</button>
        <button data-mode="overlay" ${hasFigma ? '' : 'disabled'}>Overlay</button>
        <button data-mode="diff" ${hasFigma ? '' : 'disabled'}>Difference</button>
        ${canLive ? '<button class="livebtn" type="button" title="Overlay the live localhost page">Live</button>' : ''}
        ${canLive ? '<button class="refreshbtn" type="button" title="Reload the live page">⟳</button>' : ''}
      </div>
    </header>

    <div class="controls">
      <label>Implementation opacity <input type="range" class="opacity" min="0" max="100" value="50"></label>
      <label>Wipe <input type="range" class="wipe" min="0" max="100" value="100"></label>
    </div>

    <div class="align">
      <span>Drag overlay to re-align a section · <b class="delta">Δ 0px</b></span>
      <button class="reset" type="button">Reset alignment</button>
      <span class="hint">drag, or ↑/↓ ←/→ to nudge (Shift = 10px)</span>
    </div>

    <div class="sidealign">
      <span>Drag either side up/down to re-sync · <b class="sdelta">Δ 0px</b></span>
      <button class="sreset" type="button">Reset</button>
      <span class="hint">drag a side, or focus it and use ↑/↓ (Shift = 10px)</span>
    </div>

    <div class="stage">
      <div class="pane figma-pane">
        <span class="tag">Figma</span>
        ${figmaImg || '<div class="missing">no frame</div>'}
      </div>
      <div class="pane impl-pane">
        <span class="tag impl-tag">Implementation</span>
        <div class="impl-holder">${implImg}${frame}</div>
      </div>
      <div class="pane overlay-pane">
        ${figmaImg}
        <div class="layer impl over">${implImg}${frame}</div>
      </div>
    </div>
  </section>`;
}

function buildHtml(manifest) {
  const cards = manifest.pages
    .map((p) => `<div class="page-anchor" id="page-${esc(p.name)}"></div>\n`
      + (p.breakpoints || []).map((bp) => cardHtml(p.name, p.url, bp)).join('\n'))
    .join('\n');

  // Jump bar. Widths are the union across pages (a page missing one gets it
  // disabled while it's the current page) so the row doesn't reflow while scrolling.
  const widths = [...new Set(manifest.pages.flatMap((p) => (p.breakpoints || []).map((bp) => bp.width)))]
    .sort((a, b) => a - b);
  const pageBtns = manifest.pages
    .map((p) => `<button type="button" data-nav-page="${esc(p.name)}">${esc(p.name)}</button>`)
    .join('');
  const widthBtns = widths
    .map((w) => `<button type="button" data-nav-bp="${w}">${w}</button>`)
    .join('');
  const nav = `
    <nav class="nav">
      ${manifest.pages.length > 1
        ? `<span class="navlabel">Page</span><div class="navgroup">${pageBtns}</div>` : ''}
      <span class="navlabel">Width</span><div class="navgroup">${widthBtns}</div>
    </nav>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>figma-diff report</title>
<style>
  :root { --bg:#0f1115; --panel:#1a1d24; --line:#2a2f3a; --txt:#e6e8ec; --muted:#9aa3b2; --accent:#4f8cff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .top { padding:18px 24px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:5; }
  .top h1 { margin:0 0 4px; font-size:18px; }
  .top p { margin:0; color:var(--muted); font-size:12px; }
  .wrap { padding:24px; display:flex; flex-direction:column; gap:28px; }
  /* --topH is the measured sticky-header height, so jump targets land below it */
  .page-anchor { scroll-margin-top:calc(var(--topH, 76px) + 12px); }
  .nav { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .navlabel { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
  .navgroup { display:flex; gap:4px; flex-wrap:wrap; margin-right:8px; }
  .navgroup button { background:transparent; color:var(--muted); border:1px solid var(--line); padding:4px 10px; border-radius:6px; cursor:pointer; font-size:12px; font-variant-numeric:tabular-nums; }
  .navgroup button:hover:not(:disabled) { color:var(--txt); border-color:var(--muted); }
  .navgroup button.active { background:var(--accent); border-color:var(--accent); color:#fff; }
  .navgroup button:disabled { opacity:.3; cursor:not-allowed; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; scroll-margin-top:calc(var(--topH, 76px) + 12px); }
  .card header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .card h3 { margin:0; font-size:14px; font-weight:600; }
  .warn { color:#ffb454; font-weight:400; }
  .modes button { background:transparent; color:var(--muted); border:1px solid var(--line); padding:5px 10px; border-radius:6px; cursor:pointer; font-size:12px; }
  .modes button:hover:not(:disabled) { color:var(--txt); }
  .modes button.active { background:var(--accent); border-color:var(--accent); color:#fff; }
  .modes button:disabled { opacity:.35; cursor:not-allowed; }
  .livebtn { margin-left:6px; }
  .livebtn.active { background:#2f9e6f; border-color:#2f9e6f; color:#fff; }
  .refreshbtn { display:none; }
  .card[data-live] .refreshbtn { display:inline-block; }
  .card[data-live] .modes button[data-mode="diff"] { opacity:.35; pointer-events:none; } /* no difference in live */
  .controls { display:none; gap:24px; padding:10px 16px; border-bottom:1px solid var(--line); color:var(--muted); font-size:12px; }
  .controls label { display:flex; align-items:center; gap:8px; }
  .card[data-mode="overlay"] .controls { display:flex; }
  .align, .sidealign { display:none; align-items:center; gap:16px; padding:10px 16px; border-bottom:1px solid var(--line); color:var(--muted); font-size:12px; }
  .card[data-mode="overlay"] .align, .card[data-mode="diff"] .align { display:flex; }
  .card[data-mode="side"] .sidealign { display:flex; }
  .align .delta, .sidealign .sdelta { color:var(--accent); font-variant-numeric:tabular-nums; }
  .align .hint, .sidealign .hint { margin-left:auto; opacity:.7; }
  .align .reset, .sidealign .sreset { background:transparent; color:var(--muted); border:1px solid var(--line); padding:4px 10px; border-radius:6px; cursor:pointer; font-size:12px; }
  .align .reset:hover, .sidealign .sreset:hover { color:var(--txt); }
  .stage { position:relative; background:#fff; }
  .pane { display:none; }
  .pane img, .pane .missing { display:block; width:100%; }
  .pane img { user-select:none; -webkit-user-drag:none; }
  .pane .missing { color:#888; padding:40px; text-align:center; background:#f3f3f3; }
  .tag { position:absolute; top:8px; left:8px; z-index:2; background:rgba(0,0,0,.6); color:#fff; font-size:11px; padding:2px 8px; border-radius:4px; }
  /* implementation holder can host the screenshot or a live iframe */
  .impl-holder { position:relative; width:100%; }
  .impl-img { display:block; width:100%; }
  .impl-frame { display:none; border:0; transform-origin:top left; background:#fff; }
  .card[data-live] .impl-img { display:none; }
  .card[data-live] .impl-frame { display:block; }
  /* side by side */
  .card[data-mode="side"] .stage { display:grid; grid-template-columns:1fr 1fr; gap:1px; background:var(--line); }
  /* pane sits on grey so area exposed by a shift reads as empty, not as blank page;
     the images keep their own white backing so transparent frames still composite on white */
  .card[data-mode="side"] .figma-pane, .card[data-mode="side"] .impl-pane { display:block; position:relative; background:#dfe3ea; overflow:hidden; cursor:grab; outline:none; }
  .card[data-mode="side"] .pane img, .card[data-mode="side"] .impl-holder { background:#fff; }
  .card[data-mode="side"] .pane.dragging { cursor:grabbing; }
  .card[data-mode="side"] .pane:focus-visible { box-shadow:inset 0 0 0 2px var(--accent); }
  /* overlay + diff share the stacked overlay-pane */
  .card[data-mode="overlay"] .overlay-pane, .card[data-mode="diff"] .overlay-pane { display:block; position:relative; cursor:grab; outline:none; }
  .overlay-pane.dragging { cursor:grabbing; }
  .overlay-pane .layer { position:absolute; top:0; left:0; }
  .overlay-pane .layer.impl { width:100%; }
  .overlay-pane .figma { position:relative; }
  /* iframe pointer events turned off in overlay mode */
  .overlay-pane .impl-frame { pointer-events:none; }
  .card[data-mode="diff"] .overlay-pane .impl { opacity:1 !important; mix-blend-mode:difference; clip-path:none !important; }
  .card[data-mode="diff"] .stage { background:#000; }
</style>
</head>
<body>
  <div class="top">
    <h1>figma-diff · Figma vs localhost</h1>
    <p>Generated ${manifest.generatedAt} · scale ${manifest.scale}x · ${manifest.pages.length} page(s)</p>
    ${nav}
  </div>
  <div class="wrap">
    ${cards}
  </div>
<script>
  var LIVE_OK = location.protocol !== 'file:'; // iframe -> localhost needs an http origin

  // Size the live iframe(s) of a card: render at the breakpoint width, scaled to fit
  // whichever pane is visible, using the Figma frame's aspect for height.
  function liveLayout(card) {
    var bp = parseInt(card.dataset.bp, 10) || 0;
    var figW = +card.dataset.figw, figH = +card.dataset.figh;
    if (!bp || !figW) return;
    var cssH = Math.round(figH * bp / figW);
    card.querySelectorAll('.impl-frame').forEach(function (fr) {
      var box = fr.parentElement;
      if (!card.dataset.live) { fr.style.transform=''; box.style.height=''; box.style.overflow=''; return; }
      var w = box.clientWidth;
      if (!w) return; // pane hidden — recomputed when shown
      var f = w / bp;
      fr.style.width = bp + 'px'; fr.style.height = cssH + 'px';
      fr.style.transform = 'scale(' + f + ')';
      box.style.height = (cssH * f) + 'px'; box.style.overflow = 'hidden';
    });
  }

  document.querySelectorAll('.card').forEach((card) => {
    const setMode = (mode) => {
      card.dataset.mode = mode;
      card.querySelectorAll('.modes button[data-mode]').forEach((b) =>
        b.classList.toggle('active', b.dataset.mode === mode));
      liveLayout(card);
    };
    card.querySelectorAll('.modes button[data-mode]').forEach((b) =>
      b.addEventListener('click', () => { if (!b.disabled) setMode(b.dataset.mode); }));

    // --- Live toggle ---
    const livebtn = card.querySelector('.livebtn');
    if (livebtn) {
      if (!LIVE_OK) { livebtn.disabled = true; livebtn.title = 'Open via the control panel (npm run ui) to use Live'; }
      const frames = card.querySelectorAll('.impl-frame');
      livebtn.addEventListener('click', () => {
        if (livebtn.disabled) return;
        if (card.dataset.live) {
          delete card.dataset.live; livebtn.classList.remove('active');
        } else {
          card.dataset.live = '1'; livebtn.classList.add('active');
          frames.forEach((fr) => { if (!fr.src && fr.dataset.src) fr.src = fr.dataset.src; }); // lazy load
          if (card.dataset.mode === 'diff') setMode('overlay'); // difference unavailable live
        }
        liveLayout(card);
      });
      const refreshbtn = card.querySelector('.refreshbtn');
      if (refreshbtn) refreshbtn.addEventListener('click', () => {
        frames.forEach((fr) => {
          if (!fr.dataset.src) return;
          const u = new URL(fr.dataset.src, location.href);
          u.searchParams.set('_lc', Date.now());
          fr.src = u.toString();
        });
      });
    }

    const pane = card.querySelector('.overlay-pane');
    const impl = card.querySelector('.overlay-pane .impl');
    const opacity = card.querySelector('.opacity');
    const wipe = card.querySelector('.wipe');
    if (impl && opacity) {
      const apply = () => {
        impl.style.opacity = opacity.value / 100;
        impl.style.clipPath = 'inset(0 ' + (100 - wipe.value) + '% 0 0)';
      };
      opacity.addEventListener('input', apply);
      wipe.addEventListener('input', apply);
      apply();
    }

    // --- interactive re-anchor: drag / nudge the implementation layer ---
    if (impl && pane) {
      const bp = parseInt(card.dataset.bp, 10) || 0;     // page CSS width
      const delta = card.querySelector('.delta');
      const offset = { x: 0, y: 0 };

      const render = () => {
        impl.style.transform = 'translate(' + offset.x + 'px,' + offset.y + 'px)';
        // convert displayed px -> the page's own CSS px so the readout is actionable
        const f = pane.clientWidth ? bp / pane.clientWidth : 1;
        const dy = Math.round(offset.y * f);
        const dx = Math.round(offset.x * f);
        delta.textContent = 'Δ ' + dy + 'px' + (dx ? ' / x ' + dx + 'px' : '');
      };

      // drag
      let drag = null;
      pane.addEventListener('pointerdown', (e) => {
        drag = { sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y };
        pane.setPointerCapture(e.pointerId);
        pane.classList.add('dragging');
      });
      pane.addEventListener('pointermove', (e) => {
        if (!drag) return;
        offset.x = drag.ox + (e.clientX - drag.sx);
        offset.y = drag.oy + (e.clientY - drag.sy);
        render();
      });
      const endDrag = () => { drag = null; pane.classList.remove('dragging'); };
      pane.addEventListener('pointerup', endDrag);
      pane.addEventListener('pointercancel', endDrag);
      pane.addEventListener('dragstart', (e) => e.preventDefault()); // images aren't draggable

      // keyboard nudge (pane is focusable via tabindex set below)
      pane.tabIndex = 0;
      pane.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowUp') offset.y -= step;
        else if (e.key === 'ArrowDown') offset.y += step;
        else if (e.key === 'ArrowLeft') offset.x -= step;
        else if (e.key === 'ArrowRight') offset.x += step;
        else return;
        e.preventDefault();
        render();
      });

      card.querySelector('.reset').addEventListener('click', () => {
        offset.x = 0; offset.y = 0; render();
      });
    }

    // --- side-by-side: shift one side vertically to re-sync ---
    // Small per-section deltas compound down a long capture, so by the footer the
    // two columns show different content and the comparison stops meaning anything.
    // Each side gets its own offset; the readout is their difference.
    (() => {
      const sbar = card.querySelector('.sidealign');
      const stage = card.querySelector('.stage');
      if (!sbar || !stage) return;
      const bpw = parseInt(card.dataset.bp, 10) || 0;
      const sdelta = card.querySelector('.sdelta');
      const sides = [
        { pane: card.querySelector('.figma-pane'),
          target: card.querySelector('.figma-pane > img, .figma-pane > .missing') },
        { pane: card.querySelector('.impl-pane'),
          target: card.querySelector('.impl-pane > .impl-holder') },
      ].filter((s) => s.pane && s.target);
      if (!sides.length) return;
      const off = sides.map(() => 0);

      const renderSide = () => {
        sides.forEach((s, i) => { s.target.style.transform = 'translateY(' + off[i] + 'px)'; });
        // report in the page's own CSS px, like the overlay readout
        const w = sides[0].pane.clientWidth;
        const f = w ? bpw / w : 1;
        const rel = (off[1] || 0) - (off[0] || 0);
        sdelta.textContent = 'Δ ' + Math.round(rel * f) + 'px';
      };

      sides.forEach((s, i) => {
        let d = null;
        s.pane.addEventListener('pointerdown', (e) => {
          if (card.dataset.mode !== 'side') return;
          d = { sy: e.clientY, o: off[i] };
          s.pane.setPointerCapture(e.pointerId);
          s.pane.classList.add('dragging');
        });
        s.pane.addEventListener('pointermove', (e) => {
          if (!d) return;
          off[i] = d.o + (e.clientY - d.sy);
          renderSide();
        });
        const end = () => { d = null; s.pane.classList.remove('dragging'); };
        s.pane.addEventListener('pointerup', end);
        s.pane.addEventListener('pointercancel', end);
        s.pane.addEventListener('dragstart', (e) => e.preventDefault());

        s.pane.tabIndex = 0;
        s.pane.addEventListener('keydown', (e) => {
          const step = e.shiftKey ? 10 : 1;
          if (e.key === 'ArrowUp') off[i] -= step;
          else if (e.key === 'ArrowDown') off[i] += step;
          else return;
          e.preventDefault();
          renderSide();
        });
      });

      card.querySelector('.sreset').addEventListener('click', () => {
        off.fill(0); renderSide();
      });
    })();
  });
  window.addEventListener('resize', () => document.querySelectorAll('.card[data-live]').forEach(liveLayout));

  // --- jump bar: scroll between pages / breakpoints without hunting ---
  (function () {
    const top = document.querySelector('.top');
    const nav = document.querySelector('.nav');
    const cards = Array.from(document.querySelectorAll('.card'));
    if (!nav || !cards.length) return;
    const pageBtns = Array.from(nav.querySelectorAll('[data-nav-page]'));
    const bpBtns = Array.from(nav.querySelectorAll('[data-nav-bp]'));
    let current = cards[0];

    const measure = () =>
      document.documentElement.style.setProperty('--topH', top.offsetHeight + 'px');

    // Smooth is nice for a neighbouring card, but these reports run tens of
    // thousands of px tall — animating that far just makes you wait. Snap instead.
    const jump = (card) => {
      if (!card) return;
      const far = Math.abs(card.getBoundingClientRect().top) > innerHeight * 3;
      card.scrollIntoView({ behavior: far ? 'auto' : 'smooth', block: 'start' });
    };
    const find = (page, bp) => cards.find((c) =>
      (page == null || c.dataset.page === page) && (bp == null || c.dataset.bp === bp));

    pageBtns.forEach((b) => b.addEventListener('click', () => {
      // keep the width you were looking at when switching page, if that page has it
      const bp = current && current.dataset.bp;
      jump(find(b.dataset.navPage, bp) || find(b.dataset.navPage, null));
    }));
    bpBtns.forEach((b) => b.addEventListener('click', () => {
      if (b.disabled) return;
      jump(find(current && current.dataset.page, b.dataset.navBp) || find(null, b.dataset.navBp));
    }));

    // scroll-spy: the last card whose top has passed under the header is "current"
    const sync = () => {
      const limit = top.offsetHeight + 16;
      let active = cards[0];
      for (const c of cards) {
        if (c.getBoundingClientRect().top <= limit) active = c; else break;
      }
      current = active;
      pageBtns.forEach((b) => b.classList.toggle('active', b.dataset.navPage === active.dataset.page));
      const available = cards
        .filter((c) => c.dataset.page === active.dataset.page)
        .map((c) => c.dataset.bp);
      bpBtns.forEach((b) => {
        b.disabled = !available.includes(b.dataset.navBp);
        b.classList.toggle('active', b.dataset.navBp === active.dataset.bp);
      });
    };

    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; sync(); });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => { measure(); sync(); });
    measure();
    sync();
  })();
</script>
</body>
</html>`;
}

// The manifest is written by capture.js, so anything wrong with it here means an
// interrupted or failed capture — point back at that rather than at the JSON.
function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error('No manifest.json found. Run `node figma-diff/capture.js` first.');
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `manifest.json is unreadable (${err.message}).\n`
      + '  A capture was probably interrupted. Re-run `node figma-diff/capture.js` to rebuild it.'
    );
  }
  if (!manifest || !Array.isArray(manifest.pages) || !manifest.pages.length) {
    throw new Error('manifest.json lists no pages. Run `node figma-diff/capture.js` to capture at least one.');
  }
  return manifest;
}

function main() {
  const manifestPath = path.join(OUTPUT, 'manifest.json');
  const manifest = loadManifest(manifestPath);
  const html = buildHtml(manifest);
  const dest = path.join(OUTPUT, 'index.html');
  fs.writeFileSync(dest, html);
  console.log('Wrote ' + dest);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
