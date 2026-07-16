/**
 * The panel's full stylesheet, ported verbatim from the mockups, as a string
 * injected via a <style> element under `.signals-devtools-root`.
 *
 * Why a string and not a `.css` import: this package is bundled by vite (the
 * playground), esbuild (the extension), and whatever the inline-host consumer
 * uses. A `.css` import isn't injected consistently across those (esbuild
 * emits a separate file; consumers must configure a loader). A `<style>`
 * string works everywhere with zero bundler config and keeps the panel a
 * self-contained drop-in.
 *
 * Everything is wrapped in `@scope (.signals-devtools-root)` so the generic class names
 * (.chip, .log, .node, .tab…) can't leak into or collide with the host page.
 * The 16 base colors live on `:scope`; swap them to re-theme.
 */
export const PANEL_CSS = `
@keyframes signals-devtools-blink { 50% { opacity: .35; } }
@keyframes signals-devtools-travel { to { stroke-dashoffset: -140; } }
@keyframes signals-devtools-nodepulse { 0%, 60% { opacity: 0; } 70% { opacity: .8; } 100% { opacity: 0; } }
@keyframes signals-devtools-flash { from { background-color: color-mix(in srgb, var(--thread) 34%, transparent); } to { background-color: transparent; } }
@keyframes signals-devtools-flash-svg { from { fill: color-mix(in srgb, var(--thread) 50%, var(--surface)); } to { fill: var(--surface); } }
@scope (.signals-devtools-root) {
  :scope {
    --base00: #191919; --base01: #202020; --base02: #383836; --base03: #7d7a75;
    --base04: #a19e99; --base05: #d4d3cf; --base06: #f0efed; --base07: #f9f8f7;
    --base08: #e97366; --base09: #de9255; --base0A: #eac26b; --base0B: #72bc8f;
    --base0C: #4fb9c9; --base0D: #5e9fe8; --base0E: #bf8eda; --base0F: #df84a8;
    --bg: var(--base00);
    --surface: var(--base01);
    --surface-2: color-mix(in srgb, var(--base02) 45%, var(--base01));
    --elevated: color-mix(in srgb, var(--base02) 70%, var(--base01));
    --border: color-mix(in srgb, var(--base02) 60%, var(--base00));
    --border-strong: var(--base02);
    --row-line: color-mix(in srgb, var(--base01) 70%, var(--base00));
    --text: var(--base05); --muted: var(--base04); --faint: var(--base03);
    --atom: var(--base0A); --computed: var(--base0C); --watcher: var(--base0E);
    --effect: var(--base0B); --danger: var(--base08); --suspended: var(--base0D);
    --system: var(--base04); --thread: color-mix(in srgb, var(--base0A) 72%, var(--base07));
    --sans: "IBM Plex Sans", system-ui, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, monospace;
    position: absolute; inset: 0; display: flex; flex-direction: column;
    background: var(--bg); color: var(--text); font: 12px/1.45 var(--sans);
  }
  :scope, :scope * { box-sizing: border-box; }
  button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
  :focus-visible { outline: 2px solid var(--thread); outline-offset: 1px; border-radius: 3px; }

  /* chrome */
  .chrome { display: flex; align-items: stretch; background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 10px; flex: none; }
  .brand { display: flex; align-items: center; gap: 7px; padding: 8px 12px 8px 2px; margin-right: 4px; font-weight: 600; letter-spacing: .02em; }
  .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--thread); box-shadow: 0 0 8px var(--thread); }
  .tabs { display: flex; align-items: stretch; }
  .tab { display: flex; align-items: center; padding: 0 14px; color: var(--muted); border-bottom: 2px solid transparent; font-weight: 500; }
  .tab[aria-current="page"] { color: var(--text); border-bottom-color: var(--thread); }
  .tab:hover { color: var(--text); }
  .chrome .spacer { flex: 1; }
  .rec { display: flex; align-items: center; gap: 6px; color: var(--muted); font: 11px var(--mono); }
  .rec .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); animation: signals-devtools-blink 1.6s ease-in-out infinite; }
  .theme-btn { align-self: center; margin-right: 12px; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 3px 10px; font: 11px var(--mono); background: var(--surface); }
  .theme-btn:hover { color: var(--text); border-color: var(--border-strong); }

  /* toolbar + controls */
  .toolbar, .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--border); flex: none; }
  .toolbar { background: var(--bg); }
  .select, .search { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font: 11px var(--mono); padding: 4px 8px; }
  .search { width: 210px; color: var(--muted); }
  .search::placeholder { color: var(--faint); }
  .kind-filters { display: flex; gap: 4px; }
  .toolbar .kind-filters { margin-left: 4px; }
  .kchip { display: inline-flex; align-items: center; gap: 5px; font: 11px var(--mono); padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); }
  .kchip .sw { width: 8px; height: 8px; border-radius: 2px; }
  .kchip.on { color: var(--text); border-color: var(--border-strong); }
  .tbtn { color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px; font-size: 11px; background: var(--surface); }
  .tbtn:hover { color: var(--text); border-color: var(--border-strong); }
  .tbtn.mode { border-radius: 0; }
  .tbtn.mode[aria-pressed="true"] { color: var(--text); background: var(--surface-2); }
  .toolbar .spacer, .controls .spacer { flex: 1; }

  /* breadcrumbs */
  .crumbs { display: flex; align-items: center; gap: 4px; font: 11px var(--mono); color: var(--faint); padding: 4px 10px; border-bottom: 1px solid var(--border); flex: none; }
  .crumbs button { color: var(--muted); padding: 0 2px; }
  .crumbs button:hover { color: var(--text); }
  .crumbs .here { color: var(--computed); }

  /* timeline */
  .timeline { flex: none; border-bottom: 1px solid var(--border); padding: 6px 10px 8px; background: var(--bg); }
  .timeline svg { display: block; width: 100%; height: 56px; }
  .tl-label { font: 9.5px var(--mono); fill: var(--faint); }
  .tl-span { rx: 2; }
  .tl-window { fill: color-mix(in srgb, var(--thread) 8%, transparent); stroke: var(--thread); stroke-width: 1; stroke-dasharray: 3 3; }

  /* main split */
  .main { flex: 1; display: flex; min-height: 0; }
  .canvas-col { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .canvas-wrap { flex: 1; position: relative; overflow: auto; min-height: 0; }
  .canvas-wrap svg { display: block; width: 100%; height: 100%; min-height: 280px; }
  .canvas-status { position: absolute; left: 10px; bottom: 8px; font: 10.5px var(--mono); color: var(--faint); pointer-events: none; }
  .canvas-controls { position: absolute; top: 8px; right: 8px; z-index: 6; display: flex; gap: 4px; }
  .canvas-status b { color: var(--muted); font-weight: 500; }

  /* node list */
  .nodelist { flex: none; max-height: 168px; overflow-y: auto; border-bottom: 1px solid var(--border); }
  .nodelist table { border-collapse: collapse; width: 100%; font: 11px var(--mono); }
  .nodelist th { position: sticky; top: 0; background: var(--surface); z-index: 1; font: 600 10px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .nodelist th.sorted { color: var(--text); }
  .nodelist td { padding: 3px 10px; border-bottom: 1px solid var(--row-line); white-space: nowrap; }
  .nodelist tr:hover td { background: var(--surface); }
  .nodelist tr.selected td { background: color-mix(in srgb, var(--computed) 9%, var(--bg)); }
  .nodelist tr.selected td:first-child { box-shadow: inset 2px 0 0 var(--computed); }
  .nodelist .dot { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 7px; }
  .nodelist .num { text-align: right; color: var(--muted); }
  .nodelist .own { color: var(--watcher); }
  .nodelist .dimtxt { color: var(--faint); }
  .nodelist tfoot td { color: var(--faint); font-style: italic; border-bottom: none; }

  /* log table */
  .log { flex: 1; overflow-y: auto; font: 11.5px var(--mono); }
  .log table { border-collapse: collapse; width: 100%; }
  .log th { position: sticky; top: 0; background: var(--surface); z-index: 1; font: 600 10px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  .log td { padding: 4px 10px; border-bottom: 1px solid var(--row-line); vertical-align: baseline; white-space: nowrap; }
  .log tr:hover td { background: var(--surface); }
  .log .id { color: var(--faint); width: 48px; }
  .log .t { color: var(--muted); width: 92px; }
  .log .t .tdelta { display: block; color: var(--faint); font-size: 9.5px; }
  .log .name .lname { color: var(--text); }
  .log .took { color: var(--muted); width: 56px; text-align: right; }
  .log .data { color: var(--muted); overflow: hidden; text-overflow: ellipsis; max-width: 0; width: 40%; }
  .log .name button { color: var(--text); padding: 0; border-bottom: 1px dotted var(--faint); }
  .log .name button:hover { color: var(--computed); border-bottom-color: var(--computed); }
  .causeref { color: var(--faint); font-size: 10px; margin-left: 8px; padding: 0; }
  .kcell { display: flex; align-items: center; }
  .kcell .ntext { margin-left: 3px; }
  .g { width: 14px; align-self: stretch; position: relative; flex: none; }
  .g.vert::before, .g.tee::before { content: ""; position: absolute; left: 6px; top: -6px; bottom: -6px; width: 1px; background: var(--border-strong); }
  .g.elbow::before { content: ""; position: absolute; left: 6px; top: -6px; height: calc(50% + 6px); width: 1px; background: var(--border-strong); }
  .g.tee::after, .g.elbow::after { content: ""; position: absolute; left: 7px; top: calc(50% - 1px); width: 7px; height: 1px; background: var(--border-strong); }
  tr.op-head td { background: var(--surface-2); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); padding-top: 5px; padding-bottom: 5px; }
  tr.op-head:hover td { background: var(--surface-2); }
  tr.op-head .data { overflow: visible; max-width: none; width: auto; white-space: nowrap; }
  .op-title { font-weight: 500; }
  .op-title .tw { color: var(--faint); font-weight: 400; }
  .caret { color: var(--muted); width: 16px; font-size: 13px; line-height: 1; display: inline-block; text-align: center; padding: 0; cursor: pointer; }
  .caret:hover { color: var(--text); }
  tr.selected td { background: color-mix(in srgb, var(--thread) 8%, var(--bg)) !important; }
  tr.selected td:first-child { box-shadow: inset 2px 0 0 var(--thread); }
  tr.endrow td { color: var(--faint); }

  /* chips */
  .chip { display: inline-block; font: 500 10.5px var(--mono); padding: 1px 7px; border-radius: 3px; border: 1px solid; }
  .chip.write     { color: var(--atom); border-color: color-mix(in srgb, var(--atom) 45%, transparent); background: color-mix(in srgb, var(--atom) 9%, transparent); }
  .chip.compute   { color: var(--computed); border-color: color-mix(in srgb, var(--computed) 45%, transparent); background: color-mix(in srgb, var(--computed) 9%, transparent); }
  .chip.notify    { color: var(--watcher); border-color: color-mix(in srgb, var(--watcher) 45%, transparent); background: color-mix(in srgb, var(--watcher) 9%, transparent); }
  .chip.render    { color: var(--watcher); border-color: color-mix(in srgb, var(--watcher) 45%, transparent); background: color-mix(in srgb, var(--watcher) 9%, transparent); }
  .chip.effect    { color: var(--effect); border-color: color-mix(in srgb, var(--effect) 45%, transparent); background: color-mix(in srgb, var(--effect) 9%, transparent); }
  .chip.batch     { color: var(--atom); border-color: color-mix(in srgb, var(--atom) 45%, transparent); background: color-mix(in srgb, var(--atom) 9%, transparent); }
  .chip.async     { color: var(--suspended); border-color: color-mix(in srgb, var(--suspended) 45%, transparent); background: color-mix(in srgb, var(--suspended) 9%, transparent); }
  .chip.error     { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: color-mix(in srgb, var(--danger) 9%, transparent); }
  .chip.origin    { color: var(--thread); border-color: color-mix(in srgb, var(--thread) 45%, transparent); background: color-mix(in srgb, var(--thread) 9%, transparent); }
  .chip.system    { color: var(--system); border-color: color-mix(in srgb, var(--system) 45%, transparent); background: color-mix(in srgb, var(--system) 9%, transparent); }

  /* diffs */
  .diff-old { color: var(--faint); }
  .diff-new { color: var(--text); }
  .srclink, .srclink2 { padding: 0; color: var(--computed); border-bottom: 1px dotted var(--computed); font: inherit; }
  .diff-block { font: 11px var(--mono); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; white-space: pre; overflow-x: auto; color: var(--muted); }
  .diff-block .del { color: var(--danger); display: block; }
  .diff-block .add { color: var(--effect); display: block; }
  .diff-block .del::before { content: "- "; }
  .diff-block .add::before { content: "+ "; }
  .diff-block .ctx { display: block; }
  .diff-block .ctx::before { content: "  "; }

  /* graph canvas: nodes, edges, thread, clusters, stubs, badges */
  .layer-label { font: 600 10px var(--sans); letter-spacing: .14em; text-transform: uppercase; fill: var(--faint); }
  .node, .stub, .cluster { cursor: pointer; }
  .node rect { fill: var(--surface); stroke: var(--border-strong); stroke-width: 1; }
  .node text { font: 500 10.5px var(--mono); fill: var(--text); }
  .node .glyph { font: 600 10px var(--mono); }
  .node .sub { font: 400 9.5px var(--mono); fill: var(--muted); }
  .node .status { font: 500 9.5px var(--mono); }
  .node.atom rect     { stroke: color-mix(in srgb, var(--atom) 55%, var(--border)); }
  .node.computed rect { stroke: color-mix(in srgb, var(--computed) 55%, var(--border)); }
  .node.watcher rect  { stroke: color-mix(in srgb, var(--watcher) 55%, var(--border)); }
  .node.effect rect   { stroke: color-mix(in srgb, var(--effect) 55%, var(--border)); }
  .node.atom .glyph { fill: var(--atom); }
  .node.computed .glyph { fill: var(--computed); }
  .node.watcher .glyph { fill: var(--watcher); }
  .node.effect .glyph { fill: var(--effect); }
  .node.selected rect { stroke: var(--computed); stroke-width: 1.5; filter: drop-shadow(0 0 6px color-mix(in srgb, var(--computed) 45%, transparent)); }
  .node.suspended rect { stroke: var(--suspended); stroke-dasharray: 5 3; }
  .node.suspended .glyph, .node.suspended .sub, .node.suspended .status { fill: var(--suspended); }
  .node.error rect { stroke: var(--danger); stroke-width: 1.5; }
  .node.error .sub, .node.error .status { fill: var(--danger); }
  .node.hot .ring { animation: signals-devtools-nodepulse 2.4s ease-out infinite; }
  .badge circle { r: 7; stroke-width: 1.5; }
  .badge text { font: 700 10px var(--mono); text-anchor: middle; }
  .badge.err circle { fill: color-mix(in srgb, var(--danger) 20%, var(--bg)); stroke: var(--danger); }
  .badge.err text { fill: var(--danger); }
  .badge.sus circle { fill: color-mix(in srgb, var(--suspended) 20%, var(--bg)); stroke: var(--suspended); }
  .badge.sus text { fill: var(--suspended); }
  .stub rect { fill: transparent; stroke: var(--border-strong); stroke-dasharray: 4 3; }
  .stub text { font: 500 11px var(--mono); fill: var(--muted); }
  .stub .count { fill: var(--text); font-weight: 600; }
  .stub:hover rect { stroke: var(--muted); }
  .cluster rect { fill: color-mix(in srgb, var(--atom) 4%, var(--surface)); stroke: color-mix(in srgb, var(--atom) 45%, var(--border)); stroke-dasharray: 4 3; }
  .cluster text { font: 500 11px var(--mono); fill: var(--text); }
  .cluster .sub { font: 400 10px var(--mono); fill: var(--muted); }
  .cluster .glyph { fill: var(--atom); font: 600 11px var(--mono); }
  .edge { stroke: var(--border-strong); stroke-width: 1.2; fill: none; marker-end: url(#signals-devtools-arr); }
  .edge.dim { opacity: .55; }
  .thread { stroke: var(--thread); stroke-width: 1.8; fill: none; marker-end: url(#signals-devtools-arr-hot); filter: drop-shadow(0 0 4px color-mix(in srgb, var(--thread) 55%, transparent)); }
  .thread-anim { stroke: color-mix(in srgb, var(--thread) 45%, var(--base07)); stroke-width: 2; fill: none; stroke-dasharray: 10 130; animation: signals-devtools-travel 2.4s linear infinite; opacity: .9; }

  /* node event drawer */
  .drawer { flex: none; border-top: 1px solid var(--border); background: var(--bg); max-height: 200px; overflow-y: auto; }
  .drawer-head { display: flex; align-items: center; gap: 10px; padding: 5px 10px; background: var(--surface); border-bottom: 1px solid var(--border); font: 600 10px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); position: sticky; top: 0; }
  .drawer-head .name { color: var(--computed); font: 600 11px var(--mono); text-transform: none; letter-spacing: 0; }
  .drawer-head .spacer { flex: 1; }
  .drawer-head button { font: 11px var(--mono); color: var(--muted); text-transform: none; letter-spacing: 0; }
  .drawer-head button:hover { color: var(--text); }
  .drawer table { border-collapse: collapse; width: 100%; font: 11.5px var(--mono); }
  .drawer td { padding: 3px 10px; border-bottom: 1px solid var(--row-line); white-space: nowrap; color: var(--muted); }

  /* inspector */
  .inspector, .causality { width: 320px; flex: none; border-left: 1px solid var(--border); background: var(--surface); overflow-y: auto; }

  /* resize handles between panes */
  .resizer { flex: none; position: relative; z-index: 5; }
  .resizer-v { height: 5px; margin: -2px 0; cursor: row-resize; }
  .resizer-h { width: 5px; margin: 0 -2px; cursor: col-resize; }
  .resizer:hover, .resizer:active { background: color-mix(in srgb, var(--thread) 55%, transparent); }
  .inspector { display: flex; flex-direction: column; }
  .insp-head { padding: 12px 14px 10px; border-bottom: 1px solid var(--border); }
  .insp-kind { font: 600 10px var(--sans); letter-spacing: .14em; text-transform: uppercase; color: var(--computed); display: flex; align-items: center; gap: 6px; }
  .insp-kind .sw { width: 8px; height: 8px; border-radius: 2px; background: currentColor; }
  .insp-name { font: 600 15px var(--mono); margin-top: 4px; }
  .insp-id { font: 10.5px var(--mono); color: var(--faint); margin-top: 2px; }
  .insp-section { padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .insp-section h3 { margin: 0 0 6px; font: 600 10px var(--sans); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .insp-section h3 .win { float: right; font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--faint); }
  .kv { display: grid; grid-template-columns: 96px 1fr; row-gap: 4px; font: 11px var(--mono); }
  .kv .k { color: var(--muted); }
  .kv .v { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .value-preview { font: 11px var(--mono); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; color: var(--text); white-space: pre-wrap; overflow-x: auto; }
  .memo-bar { display: flex; height: 10px; border-radius: 3px; overflow: hidden; margin: 6px 0; }
  .memo-bar span { display: block; }
  .memo-legend { font: 10.5px var(--mono); color: var(--muted); display: grid; row-gap: 2px; }
  .memo-legend .sw { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 6px; }
  .memo-legend b { color: var(--text); font-weight: 500; }
  .ranked { list-style: none; margin: 0; padding: 0; font: 11px var(--mono); }
  .ranked li { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
  .ranked .sw { width: 7px; height: 7px; border-radius: 2px; flex: none; }
  .ranked button { color: var(--text); padding: 0; border-bottom: 1px dotted var(--faint); }
  .ranked button:hover { color: var(--computed); border-bottom-color: var(--computed); }
  .ranked .bar { flex: 1; height: 5px; border-radius: 2px; background: var(--surface-2); position: relative; min-width: 30px; }
  .ranked .bar i { position: absolute; inset: 0 auto 0 0; border-radius: 2px; background: var(--border-strong); }
  .ranked .stat { color: var(--muted); flex: none; }
  .linklist { list-style: none; margin: 0; padding: 0; }
  .linklist li { display: flex; align-items: center; gap: 7px; padding: 3px 0; white-space: nowrap; }
  .linklist .sw { width: 7px; height: 7px; border-radius: 2px; flex: none; }
  .linklist button { font: 11px var(--mono); color: var(--text); padding: 0; border-bottom: 1px dotted var(--faint); }
  .linklist button:hover { color: var(--computed); border-bottom-color: var(--computed); }
  .linklist .meta { font: 10px var(--mono); color: var(--faint); margin-left: auto; flex: none; }
  .sumline { font: 10.5px var(--mono); color: var(--muted); margin: 6px 0 4px; }
  .sumline b { color: var(--text); font-weight: 500; }

  /* causality panel */
  .cz-head { padding: 12px 14px 10px; border-bottom: 1px solid var(--border); }
  .cz-kicker { font: 600 10px var(--sans); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .cz-title { font: 600 13px var(--mono); margin-top: 4px; color: var(--effect); }
  .cz-sub { font: 10.5px var(--mono); color: var(--faint); margin-top: 2px; }
  .cz-section { padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .cz-section h3 { margin: 0 0 10px; font: 600 10px var(--sans); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .rollup { font: 11px var(--mono); color: var(--muted); }
  .rollup b { color: var(--text); font-weight: 500; }
  .impact-card { margin-top: 8px; font: 11px/1.7 var(--mono); color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; }
  .impact-card b { color: var(--text); font-weight: 500; }

  /* stack trace */
  .stack { list-style: none; margin: 0; padding: 0; font: 10.5px var(--mono); }
  .stack li { display: flex; gap: 10px; padding: 2px 0; white-space: nowrap; }
  .stack .fn { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
  .stack .loc { color: var(--faint); flex: none; margin-left: auto; }
  .stack a.srclink { flex: none; margin-left: auto; }
  .stack-editor { margin-top: 8px; font: 10.5px var(--mono); color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .stack-editor select, .stack-root { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font: 10.5px var(--mono); padding: 2px 5px; }
  .stack-root { flex: 1; min-width: 0; }

  /* spine (shared causal thread motif) */
  .spine { list-style: none; margin: 0; padding: 0; position: relative; }
  .spine::before { content: ""; position: absolute; left: 7px; top: 10px; bottom: 10px; width: 2px; background: linear-gradient(var(--thread), color-mix(in srgb, var(--thread) 70%, transparent)); box-shadow: 0 0 6px color-mix(in srgb, var(--thread) 40%, transparent); border-radius: 1px; }
  .spine li { position: relative; padding: 0 0 12px 26px; }
  .spine li:last-child { padding-bottom: 0; }
  .spine .knot { position: absolute; left: 2px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: var(--bg); border: 2px solid var(--thread); }
  .spine li.terminus .knot { background: var(--thread); box-shadow: 0 0 8px var(--thread); }
  .spine .ev { font: 11.5px var(--mono); display: flex; gap: 8px; align-items: baseline; }
  .spine .ev .id { color: var(--faint); }
  .spine .ev button { color: var(--text); padding: 0; border-bottom: 1px dotted var(--faint); }
  .spine .ev button:hover { color: var(--thread); border-bottom-color: var(--thread); }
  .spine .because { font: 10.5px var(--mono); color: var(--muted); margin-top: 2px; }
  .spine .because b { color: var(--text); font-weight: 500; }

  /* tooltips — a dotted underline hints at text tips; no help cursor (many
     tipped elements, like graph nodes, are clickable). */
  th[data-tip], .cz-section h3[data-tip], .insp-section h3[data-tip], .kv .k[data-tip], .crumbs span[data-tip] { text-decoration: underline dotted var(--faint); text-underline-offset: 3px; cursor: help; }
  .svgtip { position: fixed; z-index: 2147483000; max-width: 256px; padding: 7px 10px; font: 11px/1.45 var(--sans); color: var(--text); background: var(--elevated); border: 1px solid var(--border-strong); border-radius: 5px; box-shadow: 0 6px 24px rgba(0,0,0,.55); pointer-events: none; }

  /* theme dialog */
  .theme-dialog { width: 440px; max-width: 92vw; padding: 0; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: 0 20px 60px rgba(0,0,0,.6); }
  .theme-dialog::backdrop { background: rgba(0,0,0,.5); }
  .td-head { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
  .td-head strong { font: 600 13px var(--sans); }
  .td-sub { font: 11px var(--mono); color: var(--faint); flex: 1; }
  .td-x { color: var(--muted); font-size: 14px; cursor: pointer; }
  .td-body { padding: 14px 16px; max-height: 62vh; overflow-y: auto; }
  .td-swatches { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 16px; }
  .td-row { display: flex; align-items: center; gap: 8px; }
  .td-row input[type=color] { width: 22px; height: 22px; flex: none; padding: 0; border: 1px solid var(--border); border-radius: 4px; background: none; cursor: pointer; }
  .td-key { font: 600 11px var(--mono); color: var(--text); width: 48px; flex: none; }
  .td-role { font: 10px var(--mono); color: var(--faint); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .td-hex { width: 76px; flex: none; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font: 11px var(--mono); padding: 3px 6px; }
  .td-json-label { display: block; margin: 16px 0 5px; font: 600 10px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  .td-json { width: 100%; height: 80px; resize: vertical; box-sizing: border-box; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font: 11px var(--mono); padding: 8px; }
  .td-note { font: 11px var(--mono); margin-top: 6px; min-height: 15px; color: var(--faint); }
  .td-note.ok { color: var(--effect); }
  .td-note.err { color: var(--danger); }
  .td-foot { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid var(--border); }
  .td-foot .tbtn { padding: 5px 12px; }
  .td-foot .td-apply { color: var(--bg); background: var(--thread); border-color: var(--thread); font-weight: 600; }

  /* flash on update: a row/node re-mounts (keyed on its last event) → the
     animation replays once, fading a tint away. New log entries flash on
     insert the same way. */
  .log tbody tr { animation: signals-devtools-flash .8s ease-out; }
  .nodelist tbody tr { cursor: pointer; }
  .nodelist tbody tr.flash { animation: signals-devtools-flash .8s ease-out; }
  .node.flash rect:not(.ring) { animation: signals-devtools-flash-svg .8s ease-out; }

  @media (prefers-reduced-motion: reduce) {
    .thread-anim, .rec .pulse, .node.hot .ring,
    .log tbody tr, .nodelist tbody tr.flash, .node.flash rect:not(.ring) { animation: none; }
    .thread-anim { opacity: 0; }
  }
}
`
