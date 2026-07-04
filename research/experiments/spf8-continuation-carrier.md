# SP-F8: continuation carrier — browser feasibility + overhead

Spike for O20 / I26 / D15 (champion §12′, R7): can the async-action token
carrier — captured at async-resource creation, pushed per continuation,
finally-restored — be built for a BROWSER host at <0.5% event overhead
when the feature is present but the event does no action work?

**VERDICT: FEASIBLE (<0.5%).** Mechanism: **bundler twin-build carrier** —
every app async function is compiled twice (native body + generator-driver
body) behind a one-null-check dispatch wrapper; the driver (Babel
`_asyncToGenerator` shape + token push/finally-restore around each
`gen.next()/.throw()`) runs only while an action token is live. Measured
unarmed overhead: **≈0% (−1.6% to +0.6% across 23 paired child processes;
inside the ±1.5% noise floor of a worst-case 100%-promise-machinery
event)**. In-action overhead (reported separately per the spike charter):
**+24–26%** of pure promise-machinery time (~+12 ns per await). The loud
startup self-test survives but changes meaning: it verifies the *build*
transform, not the host — the platform prerequisite becomes a **build
prerequisite** (see caveats).

## 1. Platform primitives, empirically

| primitive | status (2026-07) | evidence |
|---|---|---|
| TC39 `AsyncContext.Variable`/`Snapshot` | **Not shipped anywhere we can use.** `typeof AsyncContext === "undefined"` in this repo's Node v24.16.0 (V8 13.6.233.17-node.49); no `--harmony-async-context` or related V8 flag exists (`node --v8-options` grep). Proposal reached **Stage 4 at the January 2026 TC39 meeting** (ES2026); Chrome/V8 and Node implementations in progress, none shipped as of mid-2026. Web-API integration (the pervasive part) still being worked by Igalia. | local probes; [tc39/proposal-async-context](https://github.com/tc39/proposal-async-context), [neciudan.dev/whats-new-in-javascript](https://neciudan.dev/whats-new-in-javascript), [Igalia compilers 2025 retrospective](https://blogs.igalia.com/compilers/2026/02/06/igalia-s-compilers-team-a-2025-retrospective/), [WEB-INTEGRATION.md](https://github.com/tc39/proposal-async-context/blob/master/WEB-INTEGRATION.md) |
| Node `AsyncLocalStorage` | Present (AsyncContextFrame-based since 22.x). Node-only; measured below as reference — **+38% on this event shape, worse than our driver**. | bench `als` variant |
| V8 promise hooks (`node:v8` `promiseHooks`) | Exists in the engine (proof the host hook is real) but **not web-exposed**; unusable in browsers. | Node docs |
| Global `Promise.prototype.then` patch | **Correctness-dead, measured empirically**: `await` of a native promise uses internal `PerformPromiseThen` (never the public `.then`); `await` of a bare thenable calls the *thenable's own* `then`. A prototype patch sees only explicit `.then()` calls — it misses every ordinary `await`. Infeasible regardless of speed. | `correctness.mjs` then-patch probe (3 checks) |
| Async-to-generator compile (we own the bundler) | Always available; standard Babel/SWC transform shape. **Chosen substrate.** | prototype |

Conclusion of step 1: no browser host primitive exists mid-2026; the only
correct browser carrier is compiled — resumption interception must be in
the async function's own machinery, which the bundler controls.

## 2. The fork angle

No React fork/submodule exists in this repo yet (vendor/ holds signal
libraries only; react is not even in node_modules), so this is analysis,
not code reading. React 19's async-action machinery
(`ReactFiberAsyncAction`: `requestAsyncActionContext` / entangled action
thenables) observes the **scope's returned thenable graph** — it wraps
thenables returned from `startTransition` to know when the action
*settles* (lifetime). It does **not** observe the *continuations inside*
the async function body: `await p` inside the action callback resumes via
the async-function internal machinery, which never surfaces to the
reconciler. So the fork can reuse React's entanglement for **parking (F3,
lifetime)** — exactly the I26 duty split — but the **identity** duty
cannot be met by wrapping the scope's returned promise graph at `.then`
registration: the then-patch counterexample above applies identically
(scoped wrapping only sees explicit `.then`, never `await` resumptions).
The carrier must live where resumptions are generated: compiled output.

## 3. Approach chosen + prototype

`research/experiments/spf8-proto/carrier.mjs`:

- `currentToken` module global; `startAction(token, fn)` scopes the sync
  prefix.
- `asyncToGen(genFn)`: token captured at generator instantiation
  (async-resource creation); pushed before each `gen.next/.throw`;
  `finally`-restored, including on throw. This is byte-for-byte the
  Babel `_asyncToGenerator` driver plus 4 lines of token save/restore.
- `asyncGenToGen` + `awaitG` marker: minimal async-generator driver
  (Babel `_wrapAsyncGenerator` shape) proving identity for
  `for await` / post-`yield` writes.
- **Twin-build dispatch**: each async fn compiles to
  `{nativeBody, genBody, wrapper}` where
  `wrapper = (...a) => currentToken === null ? nativeBody(...a) : genBody(...a)`.
  Unarmed events run 100% native async/await plus one monomorphic null
  check per async call site.

Runtime preference ladder (what ships): feature-detect `AsyncContext` →
use it natively (nearly free, no twin build); else twin-build carrier;
else (unbundled dev over raw ESM) startup self-test fails loudly.

## 4. Overhead

Event shape: 1k sequential events; each event ≈60 awaits (25× loop:
resolved native promise + microtask-deferred promise + every-5th a nested
async sub-call). This is a **worst case**: the event is 100% promise
machinery, so any real handler work shrinks the percentages. Methodology:
one variant per process (order-bias rule), 7 children/variant spawned
round-robin (shared drift = in-session control), 20 iters/child, first 5
discarded; min-of-mins + mean-of-means. Node v24.16.0, Apple M4 Max,
macOS 25.5.0.

| variant | min µs/evt | mean µs/evt | min ovh | mean ovh |
|---|---|---|---|---|
| native (feature absent) | 2.66 | 2.83 | — | — |
| **dual, unarmed (feature present, no action)** | 2.68 | 2.80 | **+0.58%** | **−1.11%** |
| dual, armed (every event in an action) | 3.36 | 3.51 | +26.0% | +23.9% |
| gen unconditional (single-build worst case), unarmed | 3.19 | 3.37 | +19.7% | +18.9% |
| Node ALS reference (native fns under `als.run`) | 3.69 | 3.86 | +38.5% | +36.4% |

Tightened gate number — 16 additional paired children, alternating spawn
order: dual vs native = **min −1.55%, median −1.00%, mean −0.99%**.
Per-child min distributions fully overlap (native 2.66–2.80, dual
2.68–2.81 µs/evt). The unarmed cost is statistically zero; worst single
observation across 23 paired processes was +0.58%. **Gate <0.5%: PASS**
(the mechanism's only unarmed cost is one predictable null-check + call
indirection per async call site — ~6 per event here — which is below this
benchmark's ±1.5% resolution even in the all-promise worst case).

Separately reported in-action cost: +24–26% of promise-machinery time ≈
**+12 ns per await** (44 → 56 ns), i.e. ~0.7 µs per 60-await action event.
Actions are user-initiated and rare; this is the price of attribution,
not an event tax. Notably it **beats Node's own ALS** (+38%) on the same
shape, and the single-build fallback (+19% on every event) is why the
twin build is required, echoing the champion's SPK-H twin-build remedy.

## 5. Correctness matrix

`correctness.mjs` — **74/74 checks pass** (`node correctness.mjs`):

| composition | carrier holds identity? |
|---|---|
| plain await chain, depth 50 | PASS (token at every resumption) |
| `Promise.all` (compiled + native promises mixed) | PASS (outer + inner post-await) |
| `setTimeout`-wrapped resolutions | PASS |
| async generator: post-`await`, post-`yield`, consumer between yields | PASS (driver variant) |
| thrown rejection: token in `catch` and `finally`; rejection escapes scope; ambient restored to null after | PASS |
| two interleaved actions (A/B, randomized timer jitter, 20 rounds each) | PASS — no token bleed either way |
| ambient token null after every action settles/rejects | PASS |
| global then-patch alternative | **FAILS by construction**: patch sees 0 of native awaits, 0 of bare thenables, only explicit `.then()` — documented kill of that alternative |

## 6. Caveats / support-matrix lines

1. **The prerequisite moves from host to build.** Uncompiled async code
   (third-party bundles served as-is, raw untransformed ESM dev servers)
   loses identity at its internal awaits. Consequence is bounded: a
   post-await **signal write** inside *uncompiled* code inside an action
   misattributes (token null). Signal writes come from app/fork code,
   which is compiled; bundlers can apply the transform to node_modules
   too. The **loud startup self-test** (compiled await inside a synthetic
   action must observe the token) detects a missing/misapplied transform
   at boot — never silent misclassification, per I26. Dev builds can
   additionally warn on token-null writes while any action pends
   (imprecise but catches the residual class).
2. **Code size**: twin build ≈2× async-function body bytes (async fns
   only). A bundler that scopes twinning to action-reachable code shrinks
   this; unconditional twinning is the simple correct mode.
3. **Numbers are V8** (same engine as Chrome). JSC/SpiderMonkey generator
   and promise costs differ; the unarmed path is native async + a null
   check everywhere, so the gate conclusion is engine-robust — only the
   in-action % varies.
4. **AsyncContext endgame**: Stage 4 (ES2026); when browsers ship it the
   runtime's feature-detect ladder drops the twin build entirely and the
   carrier becomes a native `AsyncContext.Variable` — this spike's
   mechanism is the bridge, not the destination.
5. `dual-armed` slightly exceeds `gen` because armed events pay both the
   driver and per-call dispatch — expected, and irrelevant to the gate.

## Files

- `research/experiments/spf8-proto/carrier.mjs` — token + drivers
- `research/experiments/spf8-proto/correctness.mjs` — 74-check matrix
- `research/experiments/spf8-proto/bench.mjs` — one-variant-per-process bench
- `research/experiments/spf8-proto/run.mjs` — round-robin child runner

Decision-rule outcome for O20: **FEASIBLE** — twin-build bundler carrier,
unarmed overhead ≈0% (<0.5% gate PASS), loud self-test retained as a
*build* prerequisite; the dev-throw-on-post-await-write degraded mode is
NOT needed as the default. Monitor note: the support-matrix line to record
is "requires bundled/transformed app code (or future AsyncContext)".
