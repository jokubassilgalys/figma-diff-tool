/**
 * Fulfils output/figma-needed.json automatically by driving the Figma MCP
 * through a headless `claude -p` invocation (the MCP isn't reachable from a
 * plain node process, but the Claude CLI has it configured).
 *
 * Claude is asked to call get_screenshot for each queued frame and then run
 * mcp-apply.js with the resulting URLs, which downloads them into the cache and
 * clears the queue.
 *
 * Usage: node figma-diff/fulfill-figma.js
 * Exit:  0 if the queue is empty afterwards, 1 otherwise.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const NEEDED = path.join(__dirname, 'output', 'figma-needed.json');

const PROMPT = `You are fulfilling a Figma render queue for a local visual-QA tool. Work only with the files mentioned; do not touch anything else.

1. Read the file figma-diff/output/figma-needed.json. It has a "frames" array; each frame has: fileKey, nodeId, maxDimension, and out (a path relative to figma-diff/output/).
2. For EACH frame, call the Figma MCP tool get_screenshot with that frame's fileKey and nodeId, and pass maxDimension EXACTLY as the integer 65536 (do not substitute a smaller value like 1024 or 4096 — a smaller value downscales the frame and ruins the comparison). Collect each returned image_url.
3. Download them all in ONE command:
     node figma-diff/mcp-apply.js <out1> <url1> <out2> <url2> ...
   (mcp-apply.js saves each url to figma-diff/output/<out> and clears the queue.)
4. When mcp-apply.js has succeeded, stop. Do not call any other tools or edit any other files.`;

function main() {
  if (!fs.existsSync(NEEDED)) {
    console.log('fulfill-figma: nothing queued.');
    return;
  }
  const count = (JSON.parse(fs.readFileSync(NEEDED, 'utf8')).frames || []).length;
  console.log(`fulfill-figma: rendering ${count} frame(s) via the Figma MCP (claude -p)...`);

  const allowed = [
    'Read',
    'mcp__claude_ai_Figma__get_screenshot',
    'Bash(node figma-diff/mcp-apply.js:*)',
  ].join(',');

  const res = spawnSync(
    'claude',
    ['-p', PROMPT, '--allowedTools', allowed],
    // ignore stdin so claude doesn't wait on a (non-existent) piped input
    { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'] }
  );

  if (res.error) {
    console.error(`fulfill-figma: failed to launch claude CLI — ${res.error.message}`);
    process.exit(1);
  }

  // success = the queue file is gone (mcp-apply.js removes it once applied)
  if (fs.existsSync(NEEDED)) {
    console.error('fulfill-figma: queue still present — frames were not all applied.');
    console.error('  Most likely the Figma MCP isn\'t authenticated for the CLI. Fix once:');
    console.error('    1) run `claude`, then `/mcp`, and authenticate the "claude.ai Figma" connector');
    console.error('    2) re-run `node figma-diff/fulfill-figma.js && node figma-diff/report.js`');
    console.error('  (Or skip the MCP: wait for the REST rate limit to reset, then re-run capture.)');
    process.exit(1);
  }
  console.log('fulfill-figma: done.');
}

main();
