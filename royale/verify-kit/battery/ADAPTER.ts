// Wire this shim to YOUR RoyaleAdapter, then: pnpm install --ignore-workspace && pnpm test
// The battery imports the default export of this file. If your royale/adapter.ts
// uses a named export, re-map it here. Your adapter's own imports resolve through
// your react package's node_modules; the react/react-dom links in this package's
// package.json already point at your fork build.
export { default } from '../../../packages/react-signals-royale-sm1/royale/adapter.ts';
