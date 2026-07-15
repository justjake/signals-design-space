/**
 * base16 theme — the 16 core colors everything derives from, matching the
 * mockups. Emitted as a CSS string scoped to `.sd-root`; swap the 16 values
 * (or set them from a loaded theme) and the whole panel re-tints.
 */
export const THEME_CSS = `
.sd-root {
  --base00:#191919; --base01:#202020; --base02:#383836; --base03:#7d7a75;
  --base04:#a19e99; --base05:#d4d3cf; --base06:#f0efed; --base07:#f9f8f7;
  --base08:#e97366; --base09:#de9255; --base0A:#eac26b; --base0B:#72bc8f;
  --base0C:#4fb9c9; --base0D:#5e9fe8; --base0E:#bf8eda; --base0F:#df84a8;
  --bg:var(--base00); --surface:var(--base01);
  --surface-2:color-mix(in srgb, var(--base02) 45%, var(--base01));
  --border:color-mix(in srgb, var(--base02) 60%, var(--base00));
  --text:var(--base05); --muted:var(--base04); --faint:var(--base03);
  --atom:var(--base0A); --computed:var(--base0C); --watcher:var(--base0E);
  --effect:var(--base0B); --danger:var(--base08); --suspended:var(--base0D);
  --system:var(--base04); --thread:color-mix(in srgb, var(--base0A) 72%, var(--base07));
  position:absolute; inset:0; display:flex; flex-direction:column;
  background:var(--bg); color:var(--text);
  font:12px/1.45 "IBM Plex Sans", system-ui, sans-serif;
}
.sd-root * { box-sizing:border-box; }
.sd-chrome { display:flex; align-items:stretch; background:var(--surface); border-bottom:1px solid var(--border); padding:0 10px; flex:none; }
.sd-tab { padding:8px 14px; color:var(--muted); border-bottom:2px solid transparent; cursor:pointer; font-weight:500; background:none; border-top:none; border-left:none; border-right:none; }
.sd-tab[data-active="true"] { color:var(--text); border-bottom-color:var(--thread); }
.sd-main { flex:1; display:flex; min-height:0; }
.sd-table { border-collapse:collapse; width:100%; font:11.5px "IBM Plex Mono", ui-monospace, monospace; }
.sd-table td, .sd-table th { padding:3px 10px; border-bottom:1px solid color-mix(in srgb, var(--surface) 70%, var(--bg)); text-align:left; white-space:nowrap; }
.sd-table th { position:sticky; top:0; background:var(--surface); color:var(--muted); font:600 10px "IBM Plex Sans"; letter-spacing:.1em; text-transform:uppercase; }
.sd-scroll { flex:1; overflow:auto; min-height:0; }
.sd-chip { display:inline-block; font:500 10.5px "IBM Plex Mono"; padding:1px 7px; border-radius:3px; border:1px solid; }
.sd-name { color:var(--text); background:none; border:none; border-bottom:1px dotted var(--faint); cursor:pointer; font:inherit; padding:0; }
.sd-inspector { width:300px; flex:none; border-left:1px solid var(--border); background:var(--surface); overflow:auto; padding:12px 14px; }
.sd-inspector h3 { font:600 10px "IBM Plex Sans"; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin:14px 0 6px; }
.sd-muted { color:var(--muted); }
.sd-search { background:var(--bg); border:1px solid var(--border); border-radius:4px; color:var(--text); font:11px "IBM Plex Mono"; padding:4px 8px; margin:6px 10px; }
`
