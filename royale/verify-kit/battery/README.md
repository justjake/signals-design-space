# Royale battery — per-entrant provisioning (PLACEHOLDER README)

This directory is the shared Real-React gate battery. It is entrant-agnostic:
`battery.spec.tsx` talks only to the `RoyaleAdapter` default-exported by
`./ADAPTER.ts`, plus the DOM and the React modules the adapter itself hands
over. Two things are rewritten per entry at scoring time:

1. **`ADAPTER.ts`** — a one-line shim. The checked-in version points at the
   alt-b calibration adapter. For an entry, replace it with:

   ```ts
   import adapter from 'react-signals-royale-<slug>/royale/adapter';
   export default adapter;
   ```

   (or a relative import into wherever the entry was copied).

2. **`package.json` `link:` targets** — `react`, `react-dom`, and `scheduler`
   must point at the ENTRANT's built fork
   (`.../vendor/react/build/oss-experimental/*` of their checkout after
   `build.sh`), and the `cosignals-alt-b` dev-dependency is replaced by
   `link:` entries for the entry's two packages so the ADAPTER shim can
   import them.

Then:

```sh
pnpm install --ignore-workspace   # inside this directory
pnpm test                         # vitest run, jsdom, pool=forks
```

Why `link:`: the battery, the entrant's bindings, and the adapter must all
resolve to ONE React instance — the entrant's own build. `link:` preserves
realpath identity without copying, and a fork rebuild needs no reinstall.

Scenario 18 (SSR) is the only scenario allowed to fail-loudly-as-skip, and
only when the adapter genuinely lacks `serialize`/`initialize`. Everything
else must run.
