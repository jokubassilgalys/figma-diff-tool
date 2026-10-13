# figma-diff — Figma vs localhost visual comparison

Captures each page at **375 / 768 / 1920px** from both Figma (design)
and localhost (implementation), then builds a self-contained HTML report to compare
them side-by-side, as an opacity/wipe **overlay**, and as a **difference** blend.

## Quick start

This folder is self-contained — it runs on its own:

```bash
npm install                      # installs playwright
npx playwright install chromium  # one-time browser download
cp .env.example .env             # then paste your Figma token into .env
npm run ui                       # control panel at http://localhost:4321
```

Make sure the site you're comparing is being served (e.g. `http://localhost:3000/…`)
before you hit **Run**. CLI equivalent: `npm run qa`, then open `output/index.html`.

Notes on the two files you create:

- **`.env`** holds a Figma personal access token (scope: _File content → read_) as
  `FIGMA_TOKEN=figd_xxx`. It's gitignored. Only the REST source
  needs it; `--source=mcp` and `--no-figma` runs work without one.
- **`config.json`** is gitignored, so a fresh clone has none. `npm run ui` seeds it
  from `config.example.json` automatically; to use the CLI first instead, run
  `cp config.example.json config.json`.

If port 4321 is taken: `npm run ui -- 4322` (or `QA_UI_PORT=4322 npm run ui`). The
panel binds to localhost only.

> The default `figmaSource: "auto"` fetches frames via the Figma REST API using your
> token. The automatic MCP fallback (for when REST is rate-limited) needs Claude Code
> with the Figma MCP — without it, set `figmaSource: "rest"` in config.json.
> Everything else works the same.

## Add pages

Paste the localhost URL and one **Figma frame link** per breakpoint (right-click →
_Copy link to selection_); the file key and node id are parsed automatically. From
the panel you can add/remove pages, **Run** capture+report per page (or all) with a
live log, **Open report**, and open **Live compare**. It edits `config.json` for you.

## Add pages (manual)

Or edit `config.json` directly. Each page lists its localhost URL and the Figma
**node id** for each breakpoint. To get a node id: open the frame in Figma →
right-click → _Copy link to selection_ → the `node-id=3305-23904` in the URL becomes
`3305:23904` (replace `-` with `:`).

```json
{
  "figmaFileKey": "YOUR_FIGMA_FILE_KEY",
  "figmaSource": "auto",
  "breakpoints": [375, 768, 1920],
  "scale": 2,
  "dismiss": ["#cookie-law-info-bar"],
  "pages": [
    {
      "name": "prelander",
      "url": "http://localhost:3000/prelander",
      "figma": { "375": "3305:23904", "768": "3305:23497", "1920": "3305:23052" }
    }
  ]
}
```

- `figmaFileKey` can also be set **per page** (a page in a different Figma file just
  adds its own `figmaFileKey`).
- `figmaSource` (global or per page, default `auto`) chooses where frames come from —
  see [Figma source](#figma-source-rest-vs-mcp).
- `dismiss` (global or per page) hides overlays that aren't part of the design —
  cookie bars, popups, chat widgets — via CSS selectors, applied right before
  capture. No selectors are hidden unless you list them; `config.example.json` seeds
  `["#cookie-law-info-bar"]`.

## Run (manual)

Start the site you're comparing first, then:

```bash
npm run qa                 # capture both sides + build report
npm run capture            # capture only
npm run report             # rebuild report from existing captures
node capture.js prelander  # limit to one page
```

### Flags (capture.js)

| Flag                           | Effect                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `<pageName>`                   | Only capture that page from config.json                                                                |
| `--source=auto\|rest\|mcp`     | Override the Figma source for this run                                                                 |
| `--refresh-figma`              | Re-fetch Figma frames even if already cached                                                           |
| `--no-figma`                   | Never call the Figma API — use cached frames only (safe to spam while iterating on the implementation) |
| `--auto-mcp` / `--no-auto-mcp` | Force/skip the automatic MCP fulfilment step (overrides `autoFulfillMcp`)                              |

**Figma frames are cached.** Once a frame PNG exists in `output/<page>/`, it is
reused on every run unless you pass `--refresh-figma`. So day-to-day iteration on the
implementation never touches the Figma API.

Open the result:

```bash
open output/index.html
```

## Using the report

- **Side by side / Overlay / Difference** toggle per breakpoint.
- **Jump bar** in the sticky header: buttons for each **width**, and for each **page**
  when the report has more than one. Width jumps stay within the page you're
  currently in, and switching page keeps the width you were on. Saves scrolling the
  very tall 375px captures. (Nearby jumps animate; long ones snap.)
- **Overlay**: opacity + wipe sliders.
- **Re-anchor** (overlay & difference): drag the implementation layer — or focus it
  and use ↑/↓ ←/→ (Shift = 10px) — to align a specific section. This avoids the trap
  where a few-px height difference in one section makes everything below it look
  misaligned. The `Δ` readout shows the offset in the page's own CSS pixels; _Reset
  alignment_ clears it.
- **Re-sync one side** (side-by-side): drag either column up/down, or focus it and
  use ↑/↓ (Shift = 10px). Each column has its own offset and `Δ` reports the
  difference between them, so you can re-align at the hero, scroll to the footer, and
  read how much drift accumulated in between — without which the bottom of a long
  page compares two different places. The exposed area is grey to distinguish it from
  genuine blank space.
- **Live** toggle (per card) — see below.

## Live compare

For fast iteration, toggle **Live** on any report card. It overlays the **captured
Figma frame** on a **live `<iframe>`** of the localhost page at that breakpoint, so
you edit code, refresh, and see the comparison update **without re-capturing** the
implementation — right inside the report, no separate page. Use the **⟳** button to
reload after edits.

Requirements & limits:

- The target app must be running, and the page's Figma frames must have been captured
  once (Live reuses the cached frames — it never re-fetches Figma).
- Only when the report is served over http (opened via the panel's **Open report ↗**)
  — an iframe to `localhost` needs an http origin, so the toggle is disabled in the
  standalone `file://` report.
- **No difference blend** in Live (blend modes can't composite across an iframe
  boundary) — use the static report's Difference view for that.
- In **overlay** mode the iframe is inert, so dragging re-anchors it as usual; in
  **side-by-side** it stays interactive so you can click through the real page. One
  consequence: with Live on, the side-by-side re-sync drag doesn't work on the
  implementation column — drag the Figma column instead, the relative alignment is
  the same.

### Compare two live pages (live-vs-live)

The panel's **Compare two live pages** form overlays two _live_ URLs at each
breakpoint — no capture and no Figma needed. Paste **URL A** and **URL B** (e.g.
localhost vs staging, or two branches) and open it (route: `/live?a=…&b=…`). Same
side-by-side / opacity overlay / re-anchor controls, plus the width **jump bar**, a
**Refresh** button and an **Auto** re-reload interval (off / 2s / 5s). Because
there's no Figma frame to size against, a **Page height** slider in the top bar sets
the iframe height (600–12000px, default 2200).

Both modes share one generic two-layer engine (`image` or `live`), so they behave
identically. As with figma-vs-live, there's **no difference blend** and it's
panel-served only. (Synchronized scrolling isn't supported — a parent page can't
drive a cross-origin iframe's scroll.)

## Figma rate limits (important)

Figma's REST render endpoint (`/v1/images`) is in a **"low" rate-limit bucket** even
on paid (org) plans, and once exhausted the reset window is **multiple hours**
(observed ~58h). Each frame is requested individually with a render-timeout retry +
scale-down fallback, and on a `429` the tool **aborts that fetch immediately**
(retrying while rate-limited only extends the lockout) and still produces the
implementation screenshots + report from cached frames.

To stay clear of the limit: rely on the frame cache (`--no-figma` while iterating)
and only `--refresh-figma` when a design actually changes.

## Figma source: REST vs MCP

Two ways to obtain frames, selected by `figmaSource` / `--source=`:

| Source             | How                                     | Trade-off                                                                                                |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **rest**           | Figma REST `/v1/images`                 | Fully automatable; rate-limited (see above); renders at `scale` (2× = crisp)                             |
| **mcp**            | Figma MCP `get_screenshot`              | Separate path, **not** subject to the `/v1/images` budget; needs a Claude/MCP step; renders at native 1× |
| **auto** (default) | REST first, fall back to MCP on failure | Best of both — automatic, with a rate-limit escape hatch                                                 |

A plain `node` process can't call the MCP, so frames REST can't provide are written to
`output/figma-needed.json` (fileKey + nodeId per frame). How that queue gets fulfilled
depends on `autoFulfillMcp`:

### Automatic (default — `autoFulfillMcp: true`)

`capture.js` runs the headless Claude CLI (`fulfill-figma.js` → `claude -p`) which
renders each queued frame via the Figma MCP `get_screenshot` (always at
`maxDimension: 65536`, i.e. full native resolution), downloads them with
`mcp-apply.js`, and the manifest is patched so the report comes out complete. So a
single command does everything even during a REST lockout:

```bash
npm run qa            # auto: REST, falling back to MCP for anything it can't get
npm run qa:mcp        # force the MCP path (skips the doomed REST call during a lockout)
```

Requirements: the `claude` CLI installed and the Figma MCP available to it. Each
fulfilment spins up a model (small cost + a few seconds). A resolution sanity-check
warns if any frame comes back narrower than its breakpoint.

### Manual (`autoFulfillMcp: false` or `--no-auto-mcp`)

The run stops after writing the queue and prints next steps. Fulfil it yourself (or
ask Claude in a session) by calling `get_screenshot` per frame and then:

```bash
node mcp-apply.js <page>/<bp>-figma.png "<mcp-url>" [...more pairs]
node report.js
```

To avoid touching the rate-limited endpoint at all, set `figmaSource: "mcp"` (or pass
`--source=mcp`) so frames always go through the MCP handoff.

## Notes / limitations

- The page is auto-scrolled before capture, then any remaining `data-src`/
  `data-srcset` lazyload images are forced to load and awaited, so assets render at
  every breakpoint (not just the first).
- Overlay/difference modes scale both images to equal width. Real responsive pages
  won't be pixel-identical to the design (fonts, dynamic content, image compression)
  — use the difference blend + re-anchor to spot real misalignments.
- `output/` is gitignored, so it isn't in a git clone — run a capture to create it. A
  shared zip of this folder may include one as a ready-made example.
