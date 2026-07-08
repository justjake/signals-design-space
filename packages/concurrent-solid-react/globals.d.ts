// The vendored solid-signals core guards its dev-mode diagnostics behind the
// __DEV__ compile-time constant (stock Solid substitutes it at build time).
// Tests define it via vitest's `define`; consumers bundling this package
// should define it the same way.
declare const __DEV__: boolean;
