// Bundle the four extension entries into extension/*.js. Page/content/devtools
// scripts are classic (iife); the panel is an ES module (loaded with
// type="module"). Run: pnpm build:extension
import * as esbuild from "esbuild"

const common = { bundle: true, jsx: "automatic", logLevel: "info" }
const entries = [
  { in: "src/extension/devtools.ts", out: "extension/devtools.js", format: "iife" },
  { in: "src/extension/content-script.ts", out: "extension/content-script.js", format: "iife" },
  { in: "src/extension/inject.ts", out: "extension/inject.js", format: "iife" },
  { in: "src/extension/panel-main.tsx", out: "extension/panel.js", format: "esm" },
]

for (const e of entries) {
  await esbuild.build({ ...common, entryPoints: [e.in], outfile: e.out, format: e.format })
}
