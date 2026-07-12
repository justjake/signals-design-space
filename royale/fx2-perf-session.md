# fx2 perf loop (2026-07-10): kairo vs alien 1.33x -> 1.12x local / 1.11x CI — watched-Clean skips (readDerived + validation loops), read path flattened into Signal/Computed.get, allocation-free recompute, batchPass stamp, shared evalUse; react-seam-bench fx2-react contender landed (1 render/write, urgent p95 1.55ms mid-transition); CI field-bench green after lockfile (clean-worktree gen + dalien submodule) and adapter-slug fixes. Trap: pnpm file: deps are COPIED at install — always esbuild --alias:signals-royale-fx2=<pkg>/src/index.ts and grep a marker symbol in dist before trusting A/B numbers.

Next levers: ensureFresh iterativization (~19% self-time), react mount 60->50ms gap, CI avoidablePropagation 1.39x.

Resume: `claude --resume 86836afd-8fc3-4b0b-91e4-9dc3e521bd13`
