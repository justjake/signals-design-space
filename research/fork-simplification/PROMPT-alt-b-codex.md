# Fork-simplification investigation (run with codex sol, max effort)

You are the maintainer of packages/cosignals-alt-b in /Users/jitl/src/alien-signals-opt.
Question: **if the React fork (vendor/react, +5,012 lines over upstream base e71a6393e6,
19 files) only needed to support cosignals-alt-b and nothing else, how much could it
simplify? Goal: fewest fork LoC possible.** You may redesign alt-b in tandem.

Study: vendor/react patch surface (git diff e71a6393e6..HEAD -- packages), the bridge
(packages/cosignals-alt-b/src/react*.ts) for what is ACTUALLY consumed, the engine's
protocol needs (SPEC-RESOLUTIONS.md), and the RTL suite for behavioral requirements.

Deliver research/fork-simplification/alt-b-codex.md:
1. Inventory: every fork API/event alt-b consumes, with the feature it powers.
2. The minimal protocol: smallest fork surface preserving all current RTL-verified
   behavior; LoC estimate per retained patch; what upstream mechanisms could replace
   patches (public APIs, shared internals, heuristics) and at what fidelity cost.
3. Tandem redesigns of alt-b that shrink the fork further (e.g. gate changes,
   context-probe strategies), each priced (alt LoC delta vs fork LoC saved).
4. The capability/LoC curve: minimal-fork (all features) → reduced-feature points →
   zero-fork/unpatched-React (what survives: which suspense/transition/visibility
   guarantees die without the fork).
5. Recommendation with migration sketch. Cite file:line for every inventory claim.
Read-only: write ONLY the report file.
