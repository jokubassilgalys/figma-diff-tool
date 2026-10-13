/**
 * Saves Figma MCP get_screenshot URLs into the output cache.
 *
 * The MCP isn't reachable from a node process, so the flow is:
 *   1) `node capture.js --source=mcp` (or auto, when REST is rate-limited) writes
 *      output/figma-needed.json listing the frames + their node ids + resolution.
 *   2) A Claude/MCP step calls get_screenshot for each and collects the URLs.
 *   3) This script downloads those URLs into output/<page>/<bp>-figma.png.
 *
 * Usage:
 *   node figma-diff/mcp-apply.js <relPath> <url> [<relPath> <url> ...]
 *   e.g. node figma-diff/mcp-apply.js offer/768-figma.png "https://.../asset/abc"
 */
const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, 'output');

const NEEDED = path.join(OUTPUT, 'figma-needed.json');

// Drop only the frames that actually landed, and delete the queue solely when it
// empties. fulfill-figma.js treats "queue file gone" as success, so clearing it
// wholesale would report a partial fulfilment as a complete one and silently lose
// whichever frames never arrived.
function updateQueue(savedRels) {
  let queue;
  try { queue = JSON.parse(fs.readFileSync(NEEDED, 'utf8')); }
  catch (_) { return; } // no queue (or unreadable) — nothing to reconcile
  const saved = new Set(savedRels);
  const left = (queue.frames || []).filter((f) => !saved.has(f.out));
  if (!left.length) {
    fs.unlinkSync(NEEDED);
    return;
  }
  fs.writeFileSync(NEEDED, JSON.stringify({ ...queue, frames: left }, null, 2));
  console.error(`\n${left.length} frame(s) still queued — not fulfilled by this call:`);
  left.forEach((f) => console.error(`  - ${f.out} (nodeId ${f.nodeId})`));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length % 2 !== 0) {
    console.error('usage: node figma-diff/mcp-apply.js <relPath> <url> [<relPath> <url> ...]');
    process.exit(1);
  }
  const saved = [];
  const failed = [];
  // One bad url shouldn't strand the frames after it, so each is attempted and
  // the failures are summarised at the end.
  for (let i = 0; i < args.length; i += 2) {
    const rel = args[i];
    const url = args[i + 1];
    try {
      const dest = path.join(OUTPUT, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      saved.push(rel);
      console.log(`saved ${rel}`);
    } catch (err) {
      failed.push(`${rel}: ${err.message}`);
      console.error(`FAILED ${rel} — ${err.message}`);
    }
  }
  updateQueue(saved);
  if (failed.length) {
    console.error(`\nmcp-apply: ${failed.length} of ${args.length / 2} frame(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('mcp-apply failed:', err.message);
  process.exit(1);
});
