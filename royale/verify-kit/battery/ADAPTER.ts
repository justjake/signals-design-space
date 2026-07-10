// Wire this shim to YOUR RoyaleAdapter, then: pnpm install --ignore-workspace && pnpm test
// The battery imports the default export of this file. If your royale/adapter.ts
// uses a named export, re-map it here. Your adapter's own imports resolve through
// your package's node_modules (fx2 consolidated the React bindings into
// signals-royale-fx2 as the /react subpath; its react/react-dom devDeps are the
// npm canary cut from the same commit as the vendor build).
export { default } from '../../../packages/signals-royale-fx2/royale/adapter.ts';
