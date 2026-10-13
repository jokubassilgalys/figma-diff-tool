/**
 * figma-diff control panel — a small local web UI so teammates can add pages,
 * run captures, and open the report without hand-editing config.json.
 *
 * - Paste the localhost URL + one Figma frame URL per breakpoint; the file key
 *   and node id are parsed automatically (no manual `-` -> `:`).
 * - Run capture+report per page (or all) with a live log.
 * - Open the generated report.
 *
 * No extra dependencies (plain http). Binds to localhost only.
 * Usage: node figma-diff/server.js [port]   (default 4321)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const OUTPUT = path.join(ROOT, 'output');
const CONFIG = path.join(ROOT, 'config.json');
const EXAMPLE = path.join(ROOT, 'config.example.json');
const rawPort = process.env.QA_UI_PORT || process.argv[2] || '4321';
const PORT = parseInt(rawPort, 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid port "${rawPort}". Usage: npm run ui -- 4321`);
  process.exit(1);
}
const DEFAULT_CONFIG = { figmaFileKey: '', figmaSource: 'auto', autoFulfillMcp: true, breakpoints: [375, 768, 1920], scale: 2, pages: [] };

// On first run there's no config.json (only config.example.json ships) — seed it
// so the panel and edits work out of the box.
function ensureConfig() {
  if (fs.existsSync(CONFIG)) return;
  try {
    if (fs.existsSync(EXAMPLE)) fs.copyFileSync(EXAMPLE, CONFIG);
    else fs.writeFileSync(CONFIG, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  } catch (_) { /* read falls back to defaults below */ }
}

// Never throw on a missing/malformed config — fall back to the example, then defaults.
function readConfig() {
  for (const f of [CONFIG, EXAMPLE]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { /* try next */ }
  }
  return { ...DEFAULT_CONFIG };
}
const writeConfig = (c) => fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Figma URL -> { fileKey, nodeId }. Handles /design/ and /file/, branch URLs, and
// node-id in the "3305-23904" form (converted to "3305:23904").
function parseFigmaUrl(u) {
  try {
    const url = new URL(u.trim());
    const parts = url.pathname.split('/').filter(Boolean);
    const di = parts.findIndex((p) => p === 'design' || p === 'file');
    if (di === -1) return null;
    let fileKey = parts[di + 1];
    if (parts[di + 2] === 'branch' && parts[di + 3]) fileKey = parts[di + 3];
    const nid = url.searchParams.get('node-id');
    if (!fileKey || !nid) return null;
    return { fileKey, nodeId: nid.replace('-', ':') };
  } catch (_) {
    return null;
  }
}

// ---- run state (single run at a time) ----
let run = { active: false, log: '', page: null };

function startRun(pageName) {
  if (run.active) return;
  run = { active: true, log: '', page: pageName || 'all' };
  const append = (d) => { run.log += d.toString(); };
  const capArgs = [path.join(ROOT, 'capture.js')];
  if (pageName) capArgs.push(pageName);
  const cap = spawn('node', capArgs, { cwd: ROOT });
  cap.stdout.on('data', append);
  cap.stderr.on('data', append);
  cap.on('close', (code) => {
    append(`\n[capture exited ${code}]\n`);
    if (code !== 0) { run.active = false; return; }
    const rep = spawn('node', [path.join(ROOT, 'report.js')], { cwd: ROOT });
    rep.stdout.on('data', append);
    rep.stderr.on('data', append);
    rep.on('close', (c2) => { append(`[report exited ${c2}]\n[done]\n`); run.active = false; });
  });
  cap.on('error', (e) => { append(`failed to start: ${e.message}\n`); run.active = false; });
}

// ---- HTML ----
function page(config, msg) {
  const bps = config.breakpoints || [375, 768, 1920];
  const reportExists = fs.existsSync(path.join(OUTPUT, 'index.html'));
  // which pages are present in the current report (so per-page report links can enable)
  const reported = new Set();
  try { (JSON.parse(fs.readFileSync(path.join(OUTPUT, 'manifest.json'), 'utf8')).pages || []).forEach((p) => reported.add(p.name)); }
  catch (_) { /* no manifest yet */ }
  const rows = (config.pages || []).map((p) => {
    const have = bps.filter((b) => fs.existsSync(path.join(OUTPUT, p.name, `${b}-figma.png`))).length;
    const inReport = reportExists && reported.has(p.name);
    return `<tr>
      <td><b>${esc(p.name)}</b><div class="sub">${esc(p.url)}</div></td>
      <td>${have}/${bps.length} frames</td>
      <td class="right">
        <a class="btn" href="/report/index.html#page-${encodeURIComponent(p.name)}" target="_blank"><button class="ghost" ${inReport ? '' : 'disabled title="run this page first"'}>Report ↗</button></a>
        <form method="post" action="/run" class="inline"><input type="hidden" name="name" value="${esc(p.name)}"><button>Run</button></form>
        <form method="post" action="/delete" class="inline" onsubmit="return confirm('Remove ${esc(p.name)}?')"><input type="hidden" name="name" value="${esc(p.name)}"><button class="ghost">Delete</button></form>
      </td>
    </tr>`;
  }).join('');

  const figmaFields = bps.map((b) =>
    `<label>${b}px Figma frame URL<input name="figma_${b}" placeholder="https://figma.com/design/…?node-id=…"></label>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>figma-diff control panel</title>
<style>
  :root{--bg:#0f1115;--panel:#1a1d24;--line:#2a2f3a;--txt:#e6e8ec;--muted:#9aa3b2;--accent:#4f8cff;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:860px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:20px}
  h1{font-size:18px;margin:0} h2{font-size:14px;margin:0 0 12px} .sub{color:var(--muted);font-size:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  table{width:100%;border-collapse:collapse} td{padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}
  td.right{text-align:right;white-space:nowrap} tr:first-child td{border-top:0}
  label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);margin-bottom:10px}
  input{background:#0f1115;border:1px solid var(--line);color:var(--txt);border-radius:6px;padding:8px 10px;font-size:13px}
  button{background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:6px;padding:7px 14px;font-size:13px;cursor:pointer}
  button.ghost{background:transparent;color:var(--muted);border-color:var(--line)}
  button:disabled{opacity:.4;cursor:not-allowed}
  .inline{display:inline} .row{display:flex;gap:16px} .row>label{flex:1}
  a.btn{display:inline-block;text-decoration:none}
  .msg{background:#13351f;border:1px solid #1f5c34;color:#cdebd6;padding:10px 12px;border-radius:8px;font-size:13px}
  .err{background:#3a1620;border-color:#6b2436;color:#f0c9d2}
  pre{background:#0b0d11;border:1px solid var(--line);border-radius:8px;padding:12px;max-height:340px;overflow:auto;font-size:12px;white-space:pre-wrap;margin:0}
  .muted{color:var(--muted);font-size:12px}
</style></head><body><div class="wrap">
  <h1>figma-diff · control panel</h1>
  ${msg ? `<div class="msg ${msg.err ? 'err' : ''}">${esc(msg.text)}</div>` : ''}

  <div class="card">
    <h2>Pages</h2>
    ${rows ? `<table>${rows}</table>` : '<div class="muted">No pages yet — add one below.</div>'}
    <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
      <form method="post" action="/run" class="inline"><button>Run all</button></form>
      ${reportExists ? '<a class="btn" href="/report/index.html" target="_blank"><button class="ghost">Open report ↗</button></a>' : '<span class="muted">Report not generated yet</span>'}
    </div>
  </div>

  <div class="card">
    <h2>Add a page</h2>
    <form method="post" action="/add">
      <div class="row">
        <label>Page name<input name="name" placeholder="order-now" required></label>
        <label>Localhost URL<input name="url" placeholder="http://localhost:3000/order-now" required></label>
      </div>
      ${figmaFields}
      <div class="muted" style="margin:4px 0 12px">Paste the full Figma frame link for each breakpoint (right-click → Copy link to selection). The file key and node id are parsed automatically.</div>
      <button>Add page</button>
    </form>
  </div>

  <div class="card">
    <h2>Compare two live pages</h2>
    <form method="get" action="/live" target="_blank">
      <div class="row">
        <label>URL A<input name="a" placeholder="http://localhost:3000/order-now" required></label>
        <label>URL B<input name="b" placeholder="https://staging.example.com/order-now" required></label>
      </div>
      <label>Page height in px (optional)<input name="h" type="number" placeholder="2200"></label>
      <div class="muted" style="margin:4px 0 12px">Overlays two live pages at each breakpoint — no capture needed. E.g. localhost vs staging, or two branches.</div>
      <button>Open live vs live</button>
    </form>
  </div>

  <div class="card">
    <h2>Run log ${run.active ? '· <span style="color:var(--accent)">running…</span>' : ''}</h2>
    <pre id="log">${esc(run.log) || '(idle)'}</pre>
  </div>

  <div class="muted">Local only · config: figma-diff/config.json</div>
</div>
<script>
  async function poll(){
    try{
      const r = await fetch('/log'); const j = await r.json();
      document.getElementById('log').textContent = j.log || '(idle)';
      if(j.active){ setTimeout(poll, 1000); } else if(${run.active ? 'true' : 'false'}){ location.reload(); }
    }catch(e){ setTimeout(poll, 2000); }
  }
  ${run.active ? 'poll();' : ''}
</script>
</body></html>`;
}

// ---- Live compare ----
// Reads a PNG's pixel dimensions from its header.
function pngSize(file) {
  try { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
  catch (_) { return null; }
}

// A comparison "layer" is { kind:'image'|'live', src, label }. A stage overlays
// layer[1] on layer[0]; both render at the breakpoint width. This generic model
// is what lets a future live-vs-live mode reuse the same view with two 'live'
// layers instead of Figma-image + live-page.
function layerHtml(layer, bp, cssH) {
  if (layer.kind === 'live') {
    return `<iframe class="layer live" data-src="${esc(layer.src)}" src="${esc(layer.src)}" scrolling="no" style="width:${bp}px;height:${cssH}px"></iframe>`;
  }
  return `<img class="layer img" src="${esc(layer.src)}" alt="${esc(layer.label)}">`;
}

function liveStage(bp, cssH, layers) {
  return `
  <section class="lc" data-bp="${bp}" data-h="${cssH}" data-mode="side">
    <header>
      <h3>${bp}px</h3>
      <div class="modes">
        <button data-mode="side" class="active">Side by side</button>
        <button data-mode="overlay">Overlay</button>
      </div>
      <label class="ov ovl-opacity">Opacity <input type="range" class="opacity" min="0" max="100" value="50"></label>
      <button class="refresh ghost" type="button">Refresh</button>
      <label class="ov">Auto <select class="interval"><option value="0">off</option><option value="2">2s</option><option value="5">5s</option></select></label>
      <button class="reset ghost" type="button">Reset align</button>
      <span class="delta">Δ 0px</span>
    </header>
    <div class="stage">
      <div class="lbox base"><span class="tag">${esc(layers[0].label)}</span>${layerHtml(layers[0], bp, cssH)}</div>
      <div class="lbox over"><span class="tag">${esc(layers[1].label)}</span>${layerHtml(layers[1], bp, cssH)}</div>
    </div>
  </section>`;
}

// live-vs-live: two live pages (ad-hoc URLs). No Figma frame, so the page height
// is a chosen value, adjustable from the top bar.
function livePairPage(config, opts) {
  const bps = config.breakpoints || [375, 768, 1920];
  const h = Math.max(200, parseInt(opts.h, 10) || 2200);
  const stages = bps.map((bp) => liveStage(bp, h, [
    { kind: 'live', src: opts.a, label: 'A · ' + opts.a },
    { kind: 'live', src: opts.b, label: 'B · ' + opts.b },
  ])).join('\n');
  const top = `<h1>Live vs live <a href="/">↩ panel</a></h1>
    <div class="sub2">A · ${esc(opts.a)} &nbsp; B · ${esc(opts.b)}</div>
    <label class="ov" style="margin-top:6px">Page height <input id="hctl" type="range" min="600" max="12000" step="100" value="${h}"> <span id="hval">${h}px</span></label>`;
  return liveShell('Live vs live', top, stages);
}

// Shared HTML shell for both live views. Stages use the generic two-layer model,
// so the client script is identical whether a layer is an image or a live iframe.
function liveShell(title, topInner, stages) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  :root{--bg:#0f1115;--panel:#1a1d24;--line:#2a2f3a;--txt:#e6e8ec;--muted:#9aa3b2;--accent:#4f8cff;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 24px}
  .top h1{margin:0;font-size:16px} .top a{color:var(--muted);font-size:12px;text-decoration:none}
  .top .sub2{color:var(--muted);font-size:12px;margin-top:4px;word-break:break-all}
  .wrap{padding:24px;display:flex;flex-direction:column;gap:28px}
  /* jump bar: --topH is the measured sticky-header height, so targets clear it */
  .nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
  .navlabel{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .navgroup{display:flex;gap:4px;flex-wrap:wrap}
  .navgroup button{background:transparent;color:var(--muted);border:1px solid var(--line);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-variant-numeric:tabular-nums}
  .navgroup button:hover{color:var(--txt);border-color:var(--muted)}
  .navgroup button.active{background:var(--accent);border-color:var(--accent);color:#fff}
  .lc{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;scroll-margin-top:calc(var(--topH, 76px) + 12px)}
  .lc header{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
  .lc h3{margin:0;font-size:14px}
  .modes button,.ghost{background:transparent;color:var(--muted);border:1px solid var(--line);padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px}
  .modes button.active{background:var(--accent);border-color:var(--accent);color:#fff}
  .ov{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)} .ov select,.ov input{accent-color:var(--accent)}
  .delta{color:var(--accent);font-variant-numeric:tabular-nums;font-size:12px;margin-left:auto}
  .stage{position:relative;background:#fff}
  .lbox{background:#fff;overflow:hidden}
  .lbox .tag{position:absolute;z-index:3;top:6px;left:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;padding:2px 8px;border-radius:4px}
  .layer{display:block;border:0} .layer.img{width:100%} .layer.live{transform-origin:top left}
  .lc[data-mode=side] .stage{display:flex;gap:12px;align-items:flex-start}
  .lc[data-mode=side] .lbox{position:relative;flex:0 0 auto}
  .lc[data-mode=overlay] .stage{cursor:grab;outline:none}
  .lc[data-mode=overlay] .lbox{position:absolute;top:0;left:0} .lc[data-mode=overlay] .lbox.base{position:relative}
  .lc[data-mode=overlay] .layer{pointer-events:none}
  .lc[data-mode=side] .ovl-opacity, .lc[data-mode=side] .reset, .lc[data-mode=side] .delta{display:none}
  .lc.dragging .stage{cursor:grabbing}
  .note{padding:20px;color:var(--muted);font-size:13px;background:#0b0d11}
</style></head><body>
  <div class="top">${topInner}<nav class="nav" id="jump"></nav></div>
  <div class="wrap">${stages}</div>
<script>
  function layout(card){
    var stage=card.querySelector('.stage'); if(!stage) return;
    var bp=+card.dataset.bp, H=+card.dataset.h, mode=card.dataset.mode, gap=12;
    var full=stage.clientWidth||card.clientWidth;
    var avail=(mode==='side')?(full-gap)/2:full;
    var W=avail, f=W/bp;
    card.querySelectorAll('.lbox').forEach(function(box){
      box.style.width=W+'px';
      var live=box.querySelector('.layer.live');
      if(live){ live.style.width=bp+'px'; live.style.height=H+'px'; live.style.transform='scale('+f+')'; box.style.height=(H*f)+'px'; }
      else { box.style.height=(mode==='overlay')?(H*f)+'px':'auto'; }
    });
    stage.style.height=(mode==='overlay')?(H*f)+'px':'auto';
  }
  document.querySelectorAll('.lc').forEach(function(card){
    var stage=card.querySelector('.stage'); if(!stage) return;
    var over=card.querySelector('.lbox.over'), delta=card.querySelector('.delta');
    var opacity=card.querySelector('.opacity'), bp=+card.dataset.bp;
    var offset={x:0,y:0};
    function render(){
      if(over){ over.style.transform='translate('+offset.x+'px,'+offset.y+'px)'; over.style.opacity=(card.dataset.mode==='overlay')?(opacity.value/100):1; }
      var W=over?over.clientWidth:0, fr=W?bp/W:1;
      delta.textContent='Δ '+Math.round(offset.y*fr)+'px'+(offset.x?(' / x '+Math.round(offset.x*fr)+'px'):'');
    }
    card.querySelectorAll('.modes button').forEach(function(b){ b.addEventListener('click',function(){
      card.dataset.mode=b.dataset.mode;
      card.querySelectorAll('.modes button').forEach(function(x){ x.classList.toggle('active',x===b); });
      layout(card); render();
    }); });
    opacity.addEventListener('input',render);
    var drag=null;
    stage.addEventListener('pointerdown',function(e){ if(card.dataset.mode!=='overlay')return; drag={sx:e.clientX,sy:e.clientY,ox:offset.x,oy:offset.y}; stage.setPointerCapture(e.pointerId); card.classList.add('dragging'); });
    stage.addEventListener('pointermove',function(e){ if(!drag)return; offset.x=drag.ox+(e.clientX-drag.sx); offset.y=drag.oy+(e.clientY-drag.sy); render(); });
    function end(){ drag=null; card.classList.remove('dragging'); }
    stage.addEventListener('pointerup',end); stage.addEventListener('pointercancel',end);
    stage.addEventListener('dragstart',function(e){ e.preventDefault(); });
    stage.tabIndex=0;
    stage.addEventListener('keydown',function(e){ if(card.dataset.mode!=='overlay')return; var s=e.shiftKey?10:1;
      if(e.key==='ArrowUp')offset.y-=s; else if(e.key==='ArrowDown')offset.y+=s; else if(e.key==='ArrowLeft')offset.x-=s; else if(e.key==='ArrowRight')offset.x+=s; else return;
      e.preventDefault(); render(); });
    card.querySelector('.reset').addEventListener('click',function(){ offset.x=0; offset.y=0; render(); });
    function reload(){ card.querySelectorAll('.layer.live').forEach(function(fr){ var u=new URL(fr.dataset.src, location.href); u.searchParams.set('_lc', Date.now()); fr.src=u.toString(); }); }
    card.querySelector('.refresh').addEventListener('click',reload);
    var timer=null;
    card.querySelector('.interval').addEventListener('change',function(e){ if(timer){clearInterval(timer);timer=null;} var s=+e.target.value; if(s>0) timer=setInterval(reload,s*1000); });
    layout(card); render();
  });
  var hctl=document.getElementById('hctl');
  if(hctl){ var hval=document.getElementById('hval'); hctl.addEventListener('input',function(){ var v=+hctl.value; if(hval)hval.textContent=v+'px'; document.querySelectorAll('.lc').forEach(function(c){ c.dataset.h=v; layout(c); }); }); }
  window.addEventListener('resize',function(){ document.querySelectorAll('.lc').forEach(layout); });

  // Width jump bar, built from the stages themselves so any view using this shell
  // gets it. Long jumps snap rather than animate — these pages run very tall.
  (function(){
    var top=document.querySelector('.top'), nav=document.getElementById('jump');
    var cards=[].slice.call(document.querySelectorAll('.lc'));
    if(!top||!nav||cards.length<2) return;
    nav.innerHTML='<span class="navlabel">Width</span><div class="navgroup"></div>';
    var group=nav.querySelector('.navgroup');
    var btns=cards.map(function(c){
      var b=document.createElement('button');
      b.type='button'; b.textContent=c.dataset.bp;
      b.addEventListener('click',function(){
        var far=Math.abs(c.getBoundingClientRect().top)>innerHeight*3;
        c.scrollIntoView({behavior:far?'auto':'smooth',block:'start'});
      });
      group.appendChild(b);
      return b;
    });
    function measure(){ document.documentElement.style.setProperty('--topH', top.offsetHeight+'px'); }
    function sync(){
      var limit=top.offsetHeight+16, idx=0;
      for(var i=0;i<cards.length;i++){ if(cards[i].getBoundingClientRect().top<=limit) idx=i; else break; }
      btns.forEach(function(b,i){ b.classList.toggle('active', i===idx); });
    }
    var queued=false;
    window.addEventListener('scroll',function(){ if(queued)return; queued=true;
      requestAnimationFrame(function(){ queued=false; sync(); }); },{passive:true});
    window.addEventListener('resize',function(){ measure(); sync(); });
    // the page-height slider changes stage heights, which moves every card
    var h=document.getElementById('hctl');
    if(h) h.addEventListener('input',sync);
    measure(); sync();
  })();
</script>
</body></html>`;
}

// ---- request helpers ----
function body(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(new URLSearchParams(d)));
  });
}
function redirect(res, to, msg) {
  const q = msg ? `?msg=${encodeURIComponent(msg.text)}${msg.err ? '&err=1' : ''}` : '';
  res.writeHead(302, { Location: to + q });
  res.end();
}

function serveStatic(res, rel) {
  const file = path.join(OUTPUT, rel);
  if (!file.startsWith(OUTPUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const types = { '.html': 'text/html', '.png': 'image/png', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---- routes ----
async function route(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const msg = url.searchParams.get('msg') ? { text: url.searchParams.get('msg'), err: url.searchParams.get('err') } : null;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(readConfig(), msg));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ active: run.active, log: run.log }));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/report/')) {
    serveStatic(res, url.pathname.slice('/report/'.length));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/live') {
    const a = url.searchParams.get('a');
    const b = url.searchParams.get('b');
    if (!a || !b) { res.writeHead(400); res.end('need both a and b URL params'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(livePairPage(readConfig(), { a, b, h: url.searchParams.get('h') }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/add') {
    const f = await body(req);
    const config = readConfig();
    const name = (f.get('name') || '').trim();
    const target = (f.get('url') || '').trim();
    if (!name || !target) return redirect(res, '/', { text: 'Name and URL are required.', err: 1 });
    if ((config.pages || []).some((p) => p.name === name)) return redirect(res, '/', { text: `Page "${name}" already exists.`, err: 1 });

    const bps = config.breakpoints || [375, 768, 1920];
    const figma = {};
    const keys = new Set();
    for (const b of bps) {
      const raw = (f.get(`figma_${b}`) || '').trim();
      if (!raw) continue;
      const parsed = parseFigmaUrl(raw);
      if (!parsed) return redirect(res, '/', { text: `Couldn't parse the ${b}px Figma URL.`, err: 1 });
      figma[b] = parsed.nodeId;
      keys.add(parsed.fileKey);
    }
    if (!Object.keys(figma).length) return redirect(res, '/', { text: 'Add at least one Figma frame URL.', err: 1 });
    if (keys.size > 1) return redirect(res, '/', { text: 'Frames come from different Figma files — they must share one file.', err: 1 });

    const fileKey = [...keys][0];
    const entry = { name, url: target, figma };
    if (!config.figmaFileKey) config.figmaFileKey = fileKey;
    else if (fileKey !== config.figmaFileKey) entry.figmaFileKey = fileKey;

    config.pages = config.pages || [];
    config.pages.push(entry);
    writeConfig(config);
    return redirect(res, '/', { text: `Added "${name}".` });
  }
  if (req.method === 'POST' && url.pathname === '/delete') {
    const f = await body(req);
    const name = f.get('name');
    const config = readConfig();
    config.pages = (config.pages || []).filter((p) => p.name !== name);
    writeConfig(config);
    return redirect(res, '/', { text: `Removed "${name}".` });
  }
  if (req.method === 'POST' && url.pathname === '/run') {
    const f = await body(req);
    if (run.active) return redirect(res, '/', { text: 'A run is already in progress.', err: 1 });
    startRun(f.get('name') || null);
    return redirect(res, '/');
  }
  res.writeHead(404); res.end('not found');
}

// A throw inside an async handler is an unhandled rejection, which takes the whole
// panel down mid-session (e.g. config.json turning read-only). Keep it to a 500.
const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(`${req.method} ${req.url} failed:`, err.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`figma-diff panel error: ${err.message}`);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — the panel may already be running at http://localhost:${PORT}`);
    console.error(`  Use another port:  npm run ui -- ${PORT + 1}   (or QA_UI_PORT=${PORT + 1} npm run ui)`);
  } else if (err.code === 'EACCES') {
    console.error(`Not allowed to bind port ${PORT}. Pick a port above 1024: npm run ui -- 4321`);
  } else {
    console.error(`figma-diff panel failed to start: ${err.message}`);
  }
  process.exit(1);
});

ensureConfig();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`figma-diff control panel: http://localhost:${PORT}`);
});
