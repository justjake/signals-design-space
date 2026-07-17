# Signals Devtools — design

> Historical naming: `signals-royale-fx2` is now named `cosignals`.

Devtools for the signals libraries in this repo (cosignals-first-draft, signals-royale-fx2 /
fx2-dalien, strata, concurrent-solid-react). Two hosts, one React UI:

- **Chrome extension** — a devtools panel next to Elements/Console.
- **Inline panel** — the same components mounted in the inspected page itself
  (floating overlay or user-provided element), for tests, demos, and
  environments where an extension can't run.

Two views, each anchored to one question:

1. **Graph** — a searchable node list plus the live dependency graph.
   *Use case: "things are slow — why?"*
2. **Log** (internally: the event log; the tab says "Log" and copy says
   "entries" — "event" reads as *browser event* to newcomers) — the causal
   trace: what happened, and *why* (cause chains).
   *Use case: "something strange happened in the UI — what happened in the
   signal graph?"* Empty states and placeholders state these questions.

Scale target: **graphs up to ~100k nodes** and rings of hundreds of thousands
of events must stay usable. The design rule that follows: the frontend never
holds or draws the whole graph — it queries focused slices.

## 1. What the libraries already give us

All tracers in this repo converge on the same causal shape:

- **Event** — `{ id, kind, cause, node, data }` where `cause` is the id of
  the provoking event (`0`/undefined = operation root). `causeChain(id)` walks
  to the root. Sources:
  - cosignals-first-draft `Tracer` (packed Int32Array ring/session, 31 kinds, µs deltas)
  - fx2 / fx2-dalien `tracer.ts` (object ring, `{id, kind, cause, label, data}`)
  - strata `CausalityLog` (object ring, resolved target names)
  - cosignals-oracle `ModelEvent` (the canonical field-complete schema)
- **Graph** — enumerable nodes with kinds and labels, plus dep→sub edges:
  - cosignals-first-draft: `engine.idToInternals` / `dependencyEdges()` / `watchers` /
    `idToSignalEffect`; kinds atom / computed / watcher / signal-effect;
    `graphviz.ts` already serializes this to DOT.
  - fx2: `Flag` bits encode node kind; `Link` lists give edges; `label` field.
  - solid: `DEV.getSources` / `getObservers` / owner-tree walkers.

So the devtools does **not** need new instrumentation — it needs a **normalized
protocol** plus one small adapter per library.

## 2. Architecture

```
packages/devtools/
  protocol/    wire types + per-library adapters (no React, no DOM)
  panel/       React components: GraphExplorer, EventLog, shared inspector
  inline/      mountDevtools(el | overlay) — panel + direct in-page connection
  extension/   Chrome MV3 extension shell around the same panel
  mockups/     static HTML mockups (this phase)
```

### Connection model

Same pattern as React DevTools: a tiny **page hook** installed early creates
`globalThis.__SIGNALS_DEVTOOLS__`, and each library adapter registers its
engine/tracer with it. The hook buffers registrations until a frontend
connects, then streams messages.

- **Inline host**: panel imports the hook directly — same-realm function calls,
  no serialization needed (values inspected live).
- **Extension host**: `page hook → window.postMessage → content script →
  chrome.runtime port → devtools panel`. Everything crossing this boundary is
  structured-clone-safe; values become previews (see §3).

The panel code never knows which transport it's on; it talks to a `Backend`
interface.

### Backend interface — query, don't snapshot

At 100k nodes a connect-time snapshot is off the table. The backend is a query
surface; the adapter (in-page, next to the engine) does the walking:

```ts
interface Backend {
  counts(): { nodes: number; byKind: Record<NodeKind, number>; events: number }
  search(query: string, cap: number): GraphNode[]        // label/kind match, capped
  node(id: number): NodeDetails                          // inspector payload, incl. §4 summaries
  neighbors(id: number, dir: 'up'|'down', depth: number, cap: number):
    { nodes: GraphNode[]; edges: GraphEdge[]; truncated: FrontierStub[] }
  subscribeEvents(filter: EventFilter, cb): Unsubscribe   // filter pushed down: node id, kind class
  causeChain(eventId: number): DevtoolsEvent[]
  inspectValue(nodeId: number, path: string[]): ValuePreview  // lazy expansion
}
```

`FrontierStub` is the "and 1,204 more subscribers" marker: `{ anchorId, dir,
count, sampleLabels }`. Transitive summaries (§4) are computed adapter-side —
a BFS over the live graph is cheap in-page; shipping 100k nodes is not.

### Message flow

- **Graph**: no global snapshot. The panel subscribes to deltas for the
  *visible node set only* (`node-touched`, `edges-changed`, `node-removed`);
  the adapter filters at the source.
- **Events**: batched and flushed on microtask/frame — never one postMessage
  per trace record. Packed tracers (cosignals-first-draft) can ship sealed Int32Array
  chunks + label table and be decoded frontend-side, which keeps the
  extension path cheap under load. Node-scoped subscriptions (for the
  inspector's event drawer) push the node-id filter down to the adapter.

## 3. Protocol (normalized types)

```ts
type NodeKind = 'atom' | 'computed' | 'effect' | 'watcher'

interface GraphNode {
  id: number            // adapter-scoped; (engineId, id) is globally unique
  kind: NodeKind
  label: string | null  // user-assigned name; null → "atom#12"
  owner?: string        // owning component, e.g. "<TodoFooter>" (see Ownership below)
  status?: 'suspended' | 'error'  // absent = ok. From fx2 AsyncSuspended/AsyncError
                                  // flags, strata suspense state, spec suspend/settle
  statusDetail?: string // error message preview, or what the node is awaiting
  valuePreview?: string // short serialized preview, extension-safe
  meta?: Record<string, string | number>  // library extras: log depth, root, runs…
}

interface GraphEdge { from: number; to: number }   // dep → sub (data flows from→to)

interface DevtoolsEvent {
  id: number            // dense, monotonic per engine
  kind: string          // library vocabulary passed through, e.g. 'write', 'render-start'
  cause: number         // provoking event id; 0 = operation root
  t: number             // µs since trace start (from dt deltas or wall clock)
  node: number | null   // node this event is about; UI shows its label ("name" column)
  data: Record<string, unknown>  // kind-specific fields, passed through
}
```

Naming: user-facing UI says **name** (the node's label); the protocol field is
`node` (an id). "Subject" appears nowhere.

Decision: event `kind` is **passed through per-library**, not mapped onto a
lowest-common-denominator enum. A small `kindClass(kind): 'origin' | 'write' |
'eval' | 'notify' | 'effect' | 'batch' | 'render' | 'system'` function in the
protocol gives the UI enough to color/filter without flattening cosignals-first-draft's
31-kind vocabulary into mush.

### Origins: DOM events and stacks

Cause chains should not stop at the first write — the interesting root is
usually *user input* and *the code that called `set`*:

- **DOM event capture**: no listeners needed — when an operation root records,
  the adapter reads `window.event` (the event currently being dispatched) and,
  if present, emits a synthetic `dom-event` record (`{ type, targetPreview }`,
  e.g. `click button#toggle-3`) as the `cause` of the write. Writes during the
  same dispatch share one origin record (keyed on the Event's identity).
  Known gaps, both acceptable: `window.event` is unset in async continuations
  (a write after `await` has no DOM origin — true of any capture approach
  short of async-context tracking) and during dispatch inside shadow trees.
- **Stack capture** (opt-in — `Error().stack` costs ~µs): at operation roots,
  and optionally at node creation. Stored as `{ frames: [{fn, url, line}] }`
  after frontend-side trimming of library frames. The UI renders the top app
  frame as a source link (`onToggle · TodoItem.tsx:42`); in the extension it
  opens via `chrome.devtools.panels.openResource`, inline it just shows the
  location.

### Write diffs

Write events carry value previews of both sides: `data.old`, `data.new`
(depth/size-capped previews captured at emit time — the old value is
unreachable afterwards, so the adapter must snapshot it when tracing is on).
The frontend computes a structural diff:

- **Row summary**: the compact diff, e.g. `dog: +breed:"Jack Russell Terrier"`
  or `todos[3].done: false → true` — changed paths only.
- **Inspector**: full old and new previews side by side with added/removed/
  changed paths highlighted; lazy `inspectValue` expansion where same-realm.

## 4. View: Graph explorer

Layout — one column of stacked regions, inspector on the right:

```
| node list           | details (inspector)
|---------------------|
| graph canvas        |
|---------------------|
| node events drawer  |
```

Before any node is selected, the **node list fills the view** — it's the
entry point. Selecting a node shrinks the list to a strip at the top, opens
the graph focused on the selection, and the inspector + node event drawer
appear.

### Node list

A flat, virtualized, sortable table of all nodes — the searchable index the
canvas deliberately isn't, and the only way to rank 100k nodes by a metric.
Columns: name, kind, owner, value preview, recomputes in ring, unchanged
ratio, downstream cost, last event. Text + kind filters shared with the
toolbar. Clusters appear as single rows (`todoItem[*].done · ×2,431`)
expandable in place.

- Static columns (name/kind/owner) sort adapter-side over the full node set,
  paged. Trace-derived columns (recomputes, unchanged, cost) rank over the
  ring-active subset — sorting by them answers "who churned the most
  *recently*", which is the question that matters and keeps 100k-node sort off
  the bridge.
- Row click selects (focuses the graph, fills the inspector and drawer).

### Focus mode — how 100k nodes stays usable

The canvas never draws the whole graph. It draws a **focus set**:

- Entry is search-first: type a label, pick a node → its ego graph (upstream +
  downstream, depth 1–2) becomes the focus set. Double-click any node to
  re-focus; breadcrumb trail records the walk.
- The frontier renders as **stub nodes**: `⊞ 1,204 more subscribers`,
  `⊞ todoItem[…].done ×2,431` — click to expand a capped page of them.
  Stubs carry counts so scale is visible without being drawn.
- **Clustering**: nodes grouped by label prefix (`todoItem[*].done`) or
  creation site collapse into one cluster node with a count. Homogeneous
  fan-out (a list's per-item atoms) is one box, not 2,431.
- **Compact nodes, uniform**: every node is the same two-line box (~40px) —
  line 1: glyph · name · value (`◆ todos · Array(7)`); line 2: that node's
  live stats (`14µs · 57% cached · 6 new 3 same`, `3 sets · cost 124µs`,
  `⧗ awaiting Api.ts:18 · 120ms`, `! TypeError: reading 'id'`). All data
  stays visible on every node, focused or not. Target: hundreds legible on
  a small display; zoom for more.
- **Zero layout shift**: selection changes stroke/glow only — never a node's
  geometry. When focus moves, nodes are only hidden or revealed; every
  surviving node keeps its exact coordinates. Newly revealed nodes take free
  slots in their layer. The only thing that repositions existing nodes is
  the explicit "Tidy" button.
- Visible-set budget: target ≤ ~300 drawn nodes regardless of graph size.
  Within that budget SVG rendering is fine (styling, hit-testing, a11y);
  canvas/WebGL is the escape hatch only if we later want a zoomed-out
  overview mode, not a requirement of the core view.
- Layout: layered DAG (deps flow left→right) computed locally over the focus
  set only — deterministic, stable across expand/collapse.

### Always-on stats (no modes)

No lens/mode switch — every feature is always active. Node color always
encodes kind; each node box carries its live stats inline on its second line
(value preview · evals in ring · last eval µs · memo-hit ratio), and the node
list columns are the way to *rank* by a metric. Liveness pulses, the causal
thread, and stat badges all coexist.

### Suspended and errored computeds

Both states are loud, everywhere the node appears — never just a tint:

- **Graph canvas**: errored nodes get a red stroke and a `!` badge on the box
  corner; the value line shows the error message. Suspended nodes get a
  distinct blue dashed stroke and a `⧗` badge; the value line shows what
  they're awaiting and elapsed time. Status marks override kind coloring —
  a broken node is a broken node first, a computed second.
- **Node list**: the value cell leads with the status mark (`! TypeError: …`,
  `⧗ suspended 120ms · Api.ts:18`); **error and suspended are separate filter
  chips** with their own counts, in both views — never one combined
  "problems" chip.
- **Inspector**: a status row in Evaluation — for errors: message, the
  throwing recompute event (→ its cause chain answers "what input broke it"),
  and the captured stack; for suspensions: since-when and the settle history
  (strata `suspense-settlement`, spec suspend/settle events).
- **What is it awaiting?** Not knowable in general — a Promise carries no
  description, and correlating it back to a `fetch` through `.then` chains is
  unreliable. `statusDetail` is a best-effort ladder: (1) an explicit label
  when the async primitive knows it (a resource-style helper wrapping fetch
  can label with its URL); (2) opt-in stack capture at the suspension point —
  a source link to the code that created the promise; (3) fallback
  "awaiting Promise" + elapsed time.
- **Event log**: `eval` events that throw render a red `eval-error` chip;
  suspend/settle pairs draw as spans on the timeline like batches, and a
  settle event links back to the suspension that started it.

### Liveness

When events arrive, the affected node pulses (write = amber flash, eval = cyan
flash, effect-run = green flash) and traversed edges highlight briefly. The
last propagation path renders as the causal thread (amber filament). Delta
subscription covers only visible nodes, so this costs nothing at 100k.

### Inspector (node selected)

- **Value**: preview + lazy path expansion (`inspectValue`).
- **Evaluation**: last recompute (id, µs, depth, world), `equals` fn, and the
  **reads bar**. Framing rule: every stat is a share of ONE beginner-legible
  denominator — *times this value was read*. A read is answered three ways:
  - *from cache* — nothing had changed; no work. ("cache" over "memo": every
    developer knows caches; only React people know memo.)
  - *recomputed — same result* — ran the function, got an equal value,
    downstream work stopped here. Paired with the saving estimate ("~258µs
    downstream avoided"). Only a smell when the recompute itself is slow.
  - *recomputed — new result* — ran and propagated.

  Presentation: counts + percentages together ("12× from cache · 57%"), never
  a bare percentage — earlier drafts ("hit 57% · changed 67%") mixed two
  denominators and failed review. The node face shows at most "57% cached".
  **Total recompute time** (sum of µs in the window) stays as a headline and
  node-list column. Instability is NOT a headline stat: when a node's
  recomputes nearly always produce a new result on an object value (fresh
  identity every time, defeating caching downstream), it gets an **unstable
  badge** with a full-sentence tooltip naming the fix — the stat surfaces
  only when actionable.
- **Last eval / last render causality**: the cause chain of the most recent
  eval (computed) or delivery/render (watcher) is shown inline, always — no
  "why?" button to click.
- **Upstream** (direct deps list, then transitive summary): total transitive
  atom count, and *top recompute causes* — root-write atoms ranked by how many
  of this node's evals their writes caused (attribution: walk each eval
  event's cause chain to its root write; count per atom).
- **Downstream** (direct subs list, then transitive summary): transitive
  counts by kind, **cost per change** — mean total µs of all events caused by
  a change of this node — and *most expensive downstream*: downstream nodes
  ranked by µs attributable to this node's changes (same chain-walk
  attribution, summing `eval`/effect durations).
- All attribution stats are computed frontend-side from the trace ring and are
  windowed to it ("over last 4,096 events"); they need nothing from engines.

### Ownership

Effects and watchers are usually owned by a component (`useSignalEffect`
inside `<TodoFooter>`). Adapters populate `GraphNode.owner` where they can:
cosignals-first-draft watchers already carry root + name; React-side hooks capture the
owning component name at creation (from the fiber, the way React DevTools
resolves display names — `vendor/react/packages/react-devtools-shared` is the
reference). The UI renders owned nodes as `document.title · <TodoFooter>`,
and the graph can cluster a component's effects/watchers into one expandable
box per component.

### Node event drawer

Toggleable drawer under the canvas: the **same EventLog component**, filtered
to the selected node (`name:visibleTodos`), node filter pushed down to the
adapter. "Open in Events ↗" jumps to the full view with the filter applied.

## 5. View: Event log

Layout: **top** timeline strip, **middle** virtualized event tree, **right**
causality panel.

### Event tree — and flat mode

Two orderings, toggled in the controls; same rows, same columns:

- **Tree** (default): events nest by causal parent — the table *is* the
  consequence tree:

```
▾ #481 click   button#toggle-3    onToggle · TodoItem.tsx:42
   └ #482 write   todos           todos[3].done: false → true
      ├ #483 batch-open   batch 31   action:"toggleTodo"
      │  ├ #484 eval      visibleTodos   14µs
      │  └ #487 delivery  <TodoList>
      ├ #489 render-start pass 112
      │  └ #492 root-commit
      │     └ #495 react-effect-run  document.title · <TodoFooter>
      └ #496 batch-retire
```

- **Flat is the default**: strict time order — what actually interleaved,
  across operations. Each row shows a `⤷#id` cause reference; clicking it
  jumps to the parent row. Flat matches the log's use case ("what just
  happened?"); switch to tree for "why" questions.
- **Span entries split in flat, and the chip carries the phase**: a batch,
  transition, or render pass is one nested row in tree mode (nesting shows
  its extent; chip shows the bare name). In flat mode its extent must be
  visible against interleaving, so it renders as boundary rows whose **kind
  chips name the phase**: `batch/begin` → `batch/end`, `transition/begin` →
  `transition/commit` (or `transition/discarded`), `render/start` →
  `render/commit` — render phases match React's own vocabulary. Begin vs end
  must be distinguishable from the KIND column alone at a scan; it is never
  buried in the outcome text. The end rows are exactly the settle/commit
  entries that tree mode folds into internals.
- Root events (cause = 0 — a `dom-event` origin when captured, else the write)
  are collapsible **operation headers** with rollup stats (event count, batch,
  total µs) and the origin's source link when a stack was captured.
- Tree guides render in the **name column** (names are variable-length, so
  indentation reads naturally there); kind chips stay left-aligned in their
  own column for scanning. Guides are CSS-drawn connectors, not characters.
- Write rows summarize as a compact value diff (see §3 Write diffs); selecting
  a write shows full old/new side-by-side in the causality panel.

### Impact — what an event cost

Every event's consequence subtree is known, so its cost is too. Two surfaces:

- **Operation headers** roll up: event count, evals (+µs), components
  re-rendered (delivery targets + render-pass µs), effects run (+µs), total µs.
- **Causality panel → Impact** for the selected event: what it caused
  *directly* (children), and *ultimately* (full subtree) — broken out as
  evals / re-rendered components (named, with render time) / effects, each
  with summed durations. For a leaf: "causes nothing further", plus the
  containing operation's totals for context.

Computed frontend-side: walk the consequence subtree, sum `eval`/effect/render
durations, collect delivery targets. Render time attribution uses the
`render-start`→`render-end` span of passes inside the subtree.
- Columns: `#` · **when** · kind · name · outcome · **took** (trailing —
  reading order ends on the number). *When* is the start moment with ONE
  anchor and ONE format for every row: time since recording started
  (`12.414ms`) — mixing absolute and `+offset` formats in one column failed
  review. The offset-into-operation reading lives in the causality panel
  ("+83µs into the operation") and hover detail. *Took* is the duration
  where one exists (recomputes, effects, render passes, whole batches,
  suspensions-so-far); blank means effectively instant. Durations never
  ride inside the outcome text.
- Filters: kind class, name, text search; "collapse to roots".
- Virtualized rows; collapsed subtrees cost nothing.
- Tradeoff, accepted: rows order by causal structure (children under parents,
  siblings by time), so the time column is not strictly monotonic — a sibling
  subtree can end later than the next sibling starts. Times display as +dt
  within the operation to keep that readable.

### Causality panel (event selected)

- The **cause chain**: ancestors from operation root → selected event, as the
  causal-thread spine. When captured, the chain roots in the `dom-event` and
  the origin stack's top app frame renders as a source link. (Descendants live
  in the tree itself, so the panel doesn't duplicate them — just a rollup
  line: "13 descendant events · 96µs".)
- **Root change**: when the chain roots in a write (or a write is selected),
  full old/new value previews with the structural diff highlighted.
- Cross-links: every node name jumps to the graph; the chain's root write
  links to that atom.

### Timeline strip

Event density over time, colored by kind class; batches / render passes drawn
as spans (`batch-open`→`batch-retire`, `render-start`→`render-end`). Click-drag
selects a time window that filters the tree.

### Recording controls

Record/pause, clear, ring-vs-session mode indicator with dropped/truncated
counts (from `TraceStats`).

## 6. Learnability — vocabulary, tooltips, progressive disclosure

Developer feedback: too many new words and colors at once, unclear what's
actionable, no incremental discovery. Three responses, in priority order:

### Vocabulary

Prefer words developers already have. Display labels are mapped from library
kinds (`kindClass` keeps the raw kind in the protocol; the UI shows the
friendly label):

- **eval → recompute** (everywhere user-facing; `eval` reads as JS `eval()`).
- **write → the API verb the user typed**: `atom.set(...)` entries display
  **set**; `atom.update(fn)` entries display **update**. Both are kindClass
  `write`; the chip mirrors the user's own code. As a noun, prose says
  "change".
- **cost/change → downstream cost**.
- **"batch" means exactly one thing: the signals change group** — what
  `beginBatch()`/`endBatch()` or an action wrapper opens. It keeps the word
  by the same rule as set/update: the UI uses the word the user typed.
  Display leads with the action name when there is one ("batch · toggleTodo"),
  id otherwise ("batch #31 · ambient").
  **React's grouping is NEVER called a batch here** — its unit in this UI is
  the **render pass** (render-start → commit). React's automatic batching is
  described in tooltips as behavior ("several deliveries can share one render
  pass"), never nouned. The batch tooltip disambiguates explicitly: "the
  signals library's grouping — not React batching." (Two earlier renames of
  the signals side — "transaction", "action" — failed review because the fix
  was never renaming; it was assigning each side its own word and banning
  the overlap.)
  **What's internal vs. structure**: batch-*begin* is visible — it carries the
  action name, i.e. user intent, and forms the tree skeleton. Only the entries
  with no user intent and no user-felt effect — settle, retire, slot
  claim/release, clock sync — are **internals**: kindClass `system`, hidden by
  default behind an "internals" filter chip. Hidden children re-parent to the
  nearest visible ancestor.
- **Transitions are first-class grouping entries**, displayed as
  **transition** (not "startTransition" — the trace can't tell
  `startTransition` from `useTransition` from a library transition API). The adapter wraps/instruments `startTransition`; changes made
  inside nest under it, and the resulting non-urgent render pass displays as
  a **transition render pass** — with its yields/resumes visible and, when
  React throws the work away, a *discarded* disposition linked back to the
  transition ("why did my UI never show that state?"). Timeline draws
  transition passes hatched to distinguish them from urgent passes.
- **Effect entries display the creating API** — same rule as set/update:
  `effect` (library `effect()`) vs `useSignalEffect` (component hook), owner
  as the secondary signal (`document.title · <TodoFooter>`); tooltips state
  explicitly that `useSignalEffect` is *not* React's `useEffect`.
- **Events → Log**; copy says "entries" ("event" reads as browser event).
- Memo outcomes: *from cache / recomputed — same result / recomputed — new
  result*, all shares of one denominator: reads.

### "Why this …" phrasing

Every causal section is titled as the question it answers, in the same voice:
**"Why this recomputed"**, **"Why this ran"**, "Why this re-rendered", "Why
this suspended" — never "last X caused by" or "cause chain".

### Tooltips (required, everywhere)

Every stat label, column header, kind chip, badge, and section heading
carries a tooltip with three parts — *what it is*, *why it'd matter*, *what
to do about it*. E.g. **unchanged**: "Share of recomputes that produced the
same value as before — downstream work stopped there. Only a problem if this
node's recompute is itself slow; then consider splitting it or memoizing its
inputs." Elements with tooltips get a dotted underline + help cursor so
discoverability isn't hover-lottery. Canvas (SVG) elements use the SAME
styled tooltip card via a small script off `data-tip`. All tooltips anchor to
the **target element** (below it, left-aligned, flipping above at the viewport
edge) — never to the cursor. Native `<title>` is not acceptable (delayed,
unstyled). Canonical copy lives beside
the component (one source, both hosts).

### One grammar (unification pass)

Same information, one shape, everywhere:

- **Every row on every surface** (log tree, node drawer, node list) reads as a
  sentence: *when · took · verb chip · name · outcome* — one concept per
  column: when it happened, how long it ran, who did what, what came of it. The **outcome** column is plain
  words ("scheduled re-render", "new result · 14µs", `5 → 4`); raw library
  fields (slot/seq/pin/maskSize) demote to internals and tooltips.
- **Color encodes who acted**, one rule across all views: amber = you (click,
  set, update, batch, startTransition), cyan = the library computing, violet =
  React rendering (notify, render), green = side-effects, red = problems,
  gray = machinery.
- **A render pass is one row** ("render root:app — pass 112 · committed ·
  26µs · re-rendered …"); its start/end/commit phases are internals. The old
  three-row form (render-start / render-end / root-commit, all named
  `root:app`) was the single largest source of visual noise.
- **delivery → notify** (a verb a beginner parses on sight; "notify
  ⟨TodoList⟩ — scheduled re-render").
- **The causality panel is one thread**, not five sections: the spine runs
  origin → selection; the value diff hangs on the knot that changed it; the
  impact card hangs on the terminus. Selected / Cause chain / Root change /
  Impact / This effect all collapsed into "Why this ran".

### Progressive disclosure

- **Node list**: default columns are just name · kind · value · last event.
  The metric columns (recomputes, time, unchanged, downstream cost) come in
  via a "+ metrics" column picker — you opt into the numbers.
- **Inspector**: Value, status, and "last recompute caused by" open by
  default; Evaluation stats, Upstream, Downstream are collapsed headers with
  their one-line summary visible ("Upstream · 2 direct · 2,443 transitive").
- **Canvas**: unselected nodes show only name + value preview; the stats
  sub-line appears on the selected/hovered node.
- **Actionability**: metric tooltips end with the action; the unstable-node
  badge (§4) is the model — the tool points at the smell and names the fix,
  the human decides.

## 6c. Review checklist — audit every change against this

Every UI change gets a grep audit over the mockups (later: panel source)
before it's reported done. A rule applies **everywhere**, not just the
surface that prompted it.

Banned in user-facing text (→ replacement):

- `subject` → name · `eval` → recompute · `write` → set / update (the API
  verb typed) · `delivery`/`delivered` → notify / notified · `wasted`,
  `cutoff` → recomputed, same result · `lens` → (no modes) ·
  `transaction`, `action N` → batch (signals grouping only; React work is a
  render pass, never a "batch") · `startTransition` as a label → transition ·
  `Events` → Log; "events" → entries · `suspend` as a status → suspended · `core-effect-run`/`react-effect-run` → the creating API (`effect` / `useSignalEffect`) ·
  combined status counts (`!1 ⧗1`) → separate error / suspended chips ·
  bare mixed-denominator percentages → counts + the reads denominator ·
  box-drawing tree glyphs → CSS guides.

Allowed exceptions: CSS class names (invisible); tooltips *explaining* an API
by name (`startTransition, useTransition, …`); raw library fields under the
internals filter.

Structural rules to re-verify: tooltips on every term/chip/header (one shared
JS fixed-position card anchored to the element — never native `<title>`, never
a clip-prone CSS `::after`); flat log default with `thing/phase` boundary
chips; span begin ≠ end distinguishable from the KIND column alone; uniform
node geometry, zero layout shift, Tidy-only re-layout; internals chip off by
default; "Why this …" phrasing for causal sections; error/suspended split
everywhere; color = who acted; **when** = start moment and **took** = duration
— durations never appear inside outcome text.

Non-events are not events. The equality cutoff — a value recomputes to the
same result, so nothing downstream fires — is the *normal mechanism* of
reactivity, not an occurrence. A React tracer doesn't log "memo returned the
same value"; neither do we. It appears only as an **opt-in per-node stat** (the
reads/memo bar), never as a log entry, a timeline mark, or an operation-header
flag. Same for a watcher that isn't notified because nothing it reads changed.
Only a genuinely anomalous drop (a delivery lost to mid-flight teardown, a
stale interleaved commit) is worth an entry — and then under the internals
filter, with its reason.

## 7. Open questions

- **Value inspection depth** over the extension bridge: design assumes lazy
  `inspectValue` path expansion; mockups show previews.
- **Multi-engine sessions**: one page can run several libraries at once
  (benchmarks do). Engine picker in the toolbar; events/nodes are namespaced
  per engine and never merged.
- **Cluster keys**: label-prefix clustering needs a labeling convention
  (`list[3].done`) or creation-site capture (stack sampling at create — has a
  cost, opt-in).

## 6b. AI handoff — copy as markdown, and that's it

Decision: the AI story is **copy as markdown**, nothing more. A live query
bridge (MCP server, or Claude-in-Chrome eval against the page hook) was
designed and **declined** — it's a whole transport surface (a localhost socket
the page dials out to, connection lifecycle, origin/mixed-content rules) for a
workflow that copy-and-paste already serves. Copy/paste has no lock-in, no
server, works with whatever agent the user already runs, and the human stays
in control of exactly what leaves the page. Embedded chat: also no — agents
live where the user codes.

**Copy as markdown, everywhere.** Every entity has a `⧉ copy as markdown`
affordance: a node (identity, value, stats, deps, why-it-recomputed chain), an
operation subtree, a why-chain, and the current log view (respecting the
tree/flat toggle and filters). The developer copies, pastes into their agent
chat, and asks.

The serialization is what makes this work, so it carries more than the screen:
- cause chain + consequence structure (ids, parent links), value diffs,
  timings, event kinds, impact rollups;
- **name-optional + structure-rich**, so it survives minified prod. Where
  labels are mangled or absent, each entry still reads by structure and value
  ("computed ← todos, filter → watcher#3, 9 recomputes, holds Array(4)"). The
  causal spine, values, and timings are runtime facts minification never
  touches — the agent reasons on those.
- **raw (minified) source frames included**, not resolved in the browser. The
  agent pasting the blob has the repo + `.map` files on disk and re-symbolicates
  frames itself (locations reliably; original identifiers best-effort via the
  sourcemap `names` field). Keeps maps out of the bundle; plays to the agent's
  filesystem access.

Minified-prod flow, end to end: reproduce with the inline panel open → copy the
relevant entry / operation / view as markdown → paste into the agent → agent
reads the causal chain over ids/structure/values and resolves the origin frame
against local source maps → points at the real handler and the change that
started it. No connection, no download beyond the clipboard.

## 7. Future ideas (not this phase)

- **Retention / leak view**: nodes created vs disposed over time; watchers
  still live after unmount; detached-but-subscribed subgraphs. Leaks are bugs;
  the devtools should make them loud.
- **Operation profile**: flame view of one operation (evals nested by cause,
  sized by µs) — the trace already contains the whole flame.
- **Time scrubbing**: pick an event, reconstruct node values as-of that point
  (cosignals-first-draft's LOGGED overlay retains history; others show last-known).
- **World / draft lanes**: timeline lanes for forked worlds and drafts
  (`draft-open`→commit/discard, render passes pinned to worlds).
- **Trace export/import**: save session chunks + label table to a file; open
  in the panel offline. Bug reports become attachable traces.
- **Page highlight**: flash the DOM regions owned by a watcher on delivery
  (React DevTools "highlight updates" analog).
- **Diagnostics feed**: surface solid-style lint events (write-during-render,
  untracked reads) as a warnings rail.

## 8. Mockup plan (this phase)

Static, self-contained HTML in `mockups/` — no build step, no framework, fake
data inline. One file per view:

- `mockups/graph-explorer.html` — node list strip, focus mode,
  cluster/frontier stubs, lenses, memo bar, upstream/downstream summaries,
  node event drawer.
- `mockups/event-log.html` — causal tree table (tree/flat toggle), timeline,
  cause-chain panel with DOM-event root, source link, and write diff.

Shared visual language between them (they'll become tabs of one panel).

## 9. Implementation plan

Three constraints shape everything: **target fx2 first without over-fitting to
it**, **the devtools uses no signals internally** (so it never pollutes the
trace it's observing), and **ship a Chrome DevTools panel**.

### Layers (what runs where)

- **`protocol/`** — pure data, no DOM, no signals: `GraphNode` / `GraphEdge` /
  `DevtoolsEvent`, `kindClass()`, the `Backend` interface, wire messages. This
  is the firewall: it's modeled on the *causal shape* (entry `{id, kind, cause,
  node, data, t}`), not on fx2's ~5 kinds nor cosignals-first-draft's ~31. Unknown kinds
  pass through to a default class; the panel renders what's present and
  degrades for what isn't.
- **`collector/` (in-page, plain JS, zero signals)** — owns the ring buffer of
  normalized entries and the node registry; subscribes to a library's trace
  seam; synthesizes higher-level entries; exposes the `Backend` query API on
  `window.__SIGNALS_DEVTOOLS__`. Plain arrays/Maps/WeakMaps — never a signals
  lib, so the devtools' own state can't appear in traces or feed back when it
  inspects the same engine.
- **adapters** — one thin module per library plugging its seam into the
  collector: kind mapping + synthesis rules, `Flag`→kind, label reader, value
  peek, dep/sub walkers. fx2's adapter is richest; a second (cosignals-first-draft)
  lands early to keep the protocol honest.
- **`panel/` (React, plain-React state)** — the mockups become components;
  state via `useReducer`/`useSyncExternalStore` over the collector store.
  Never imports a signals lib. Talks to a `Backend` (in-realm inline;
  postMessage proxy in the extension).

### fx2 — rename at the source, no runtime mapping

Strategy (per the leading-impl decision): **fx2's own trace-kind strings ARE
the vocabulary, renamed at the source to match its public API, and the panel
shows them verbatim.** No mapping/translation table at runtime. The adapter's
*only* transformations are (1) unpacking `Flag` bitfields into a kind + status,
(2) assigning node identity, (3) reading values through `untracked`. Event
strings, ids, and `cause` links pass straight through.

Verified by reading the code (both earlier "unknowns" are already satisfied):
- **Computed re-evaluation is traced**: `traceHook('compute', node, …)` fires
  right before `node.fn()` (graph.ts:1390, worlds.ts:856) — only on real
  evaluation, not on cache hits. Nothing to add.
- **State is peekable inertly — but not through the value API.** `node.value`
  holds the last-computed value *even when stale*, `node.throwable` holds the
  ErrorBox (AsyncError) or Suspension (AsyncSuspended), and `node.flags` holds
  kind + staleness + async status. Those are plain field reads: zero side
  effects. Calling the reactive read (`read(x)` — even wrapped in
  `untracked`) would **evaluate** a stale computed, advancing clocks and
  emitting a `compute` into the log you're observing. So the adapter never
  reads through the API; it reads the cached fields. fx2 should expose one
  tiny inert accessor — `inspect(node) → { value, status, throwable, stale }`
  — so the devtools doesn't reach into private fields. This is how stale
  values, errors, and suspensions are read *without* forcing recompute.
- **Identity**: `nodeOf(x)` gives the node; there's no global registry or
  stable id, so the adapter assigns a monotonic id in a `Map` keyed on the
  node object (register-on-create + one backfill walk). Entry ids reuse fx2's
  `TraceEventId` (already monotonic) so `cause` needs no remapping.

Current core trace kinds and the proposed rename (done in fx2 source):
- `write` → **`set`** / **`update`** — the intent (`'set'`/`'update'`) is
  already known at the write site (`appendUrgentIntent(atom, 'set'|'update')`);
  thread it into the emit. `update` even has `previous` in hand for a diff.
- `compute` → keep **`compute`** (computed family; matches `createComputed`);
  `compute-error`, `compute-suspend` keep the family.
- `effect-run` → **`effect`** (align with the `compute` family; API is
  `effect()`); `effect-error` keeps.
- `settle`, `retry-ready` (async) keep.
- `draft-open` / `draft-discard` → the world/draft mechanism behind React
  transitions; the React layer tags the transition-opened draft.
- `callback-error` / `cleanup-error` / `flush-error` / `policy-error` carry a
  `phase` — one error kind, phase unpacked for display.
- Node kind by unpacking `Flag`: `KindAtom`→atom, `KindComputed`→computed,
  `Watching|WatchRender`→watcher, `Watching|WatchRunEffect`→effect;
  `AsyncError`→error, `AsyncSuspended`→suspended.

What must be **added** to fx2 (the React binding emits **no** trace events
today — confirmed):
- In `src/react/` (SignalsFrameworkProvider, host, transitions): emit
  **`notify`** (a watcher delivery — the `deliver` path), **`render`** (pass
  start), **`commit`**, and tag transition-opened drafts. These concepts exist
  as internal phases; they're just untraced.
- Optional core: **`batch`** begin/flush/close (batching exists via
  `startBatch`/`endBatch`/`batchDepth` but isn't traced).
- **From-cache stat**: reads aren't traced and there's no per-node
  eval/hit counter, so the memo bar's "from cache" bucket isn't derivable
  today. Add lightweight per-node counters (read via `untracked`), or ship the
  bar with only compute→same / compute→changed until then.
### Reading model — no observer effect

Two sources of truth, split by what each is good for:

- **Current value = on-demand inert peek** (the `inspect(node)` field read).
  Inline: direct. Extension: an `inspectNode` RPC that peeks page-side and
  returns a capped, structured-clone preview. Never snapshot every node into
  every event. A stale computed shows its last value + a "stale" marker; an
  uninitialized one shows "not yet evaluated" — both without evaluating.
- **Retained `Map<node, DebugState>`, reduced over the event stream** — for
  what a bounded ring and a single peek can't give: run counts, changed/same
  tallies (the memo stat), status transitions, last-change event id. Fed by
  events, not by polling. It's also the reconstruction the panel folds when it
  can't field-peek across the postMessage boundary.
- **Events carry only deltas where the value IS the causal content.**
  `set`/`update` carry an old→new preview because the old value is
  unrecoverable after the write — you can't peek the past. `compute` carries a
  changed bit (compare cached value before/after), not the full value; the
  current value comes from the peek. So event size stays bounded and the log
  isn't a value dump.

Hard rule (extends "no signals internally"): the devtools **never calls the
reactive read/write API** — only inert field reads via `inspect(node)`. Any
`read(x)`/`set(x)` from the observer would evaluate, write, or emit, i.e.
pollute the thing it's measuring.

### fx2 packaging: the `./debug` contract

The observability surface lives behind a `./debug` subpath export, not the
main entry. Two reasons, the second more important than the first:

- **Opt-in / tree-shaken.** A prod app that doesn't debug never pulls the
  tracer, `inspect`, graph-walk, or Flag-unpack code into its bundle.
- **It's the stable contract.** `./debug` is *inside* fx2, so it can read
  private node fields (`node.value`, `node.throwable`, `node.flags`) and know
  the `Flag` bits — but it exposes stable shapes (`inspect(node) → {value,
  status, throwable, stale}`, a `TraceKind` union, dep/sub walkers). The
  devtools imports **only** `signals-royale-fx2/debug`, never core internals,
  so fx2 can refactor internals freely as long as `./debug` holds. This is the
  encapsulation that keeps "no reaching into private fields" true.

Structure:
- `./debug/trace` — the Tracer, `TraceEvent`, and the canonical **`TraceKind`
  union** (the renamed strings live here as the one source of vocabulary; the
  devtools' `kindClass()` is built against it — no separate mapping).
- `./debug/inspect` — the inert `inspect(node)` peek, `Flag`→kind/status
  unpackers, `nodeOf`, dep/sub enumeration, node-id assignment.
- `./debug/index` — umbrella re-export, published as the `./debug` subpath.

Split by concern (a consumer can want the event stream without the state peek,
or vice versa), umbrella for the common "give me everything" case. The **emit
seam stays in core**: the nullable `traceHook` pointer and the emit calls in
graph/worlds/asyncs/react cost only a null-check when no tracer is attached;
`./debug` is what you install into it and the readers it comes with. Migration
is cheap (fx2 is unpublished): move today's `.`-level tracer/`Flag`/`nodeOf`
exports to `./debug` and fix the few internal importers.

### Chrome DevTools panel

MV3, patterned on `vendor/react`'s `react-devtools-extensions` /
`-inline` / `-shared`: a `devtools_page` registers a panel that loads the same
`panel/` app; an injected page hook runs the collector; a content script
bridges page ↔ panel (`window.postMessage` ↔ `chrome.runtime` port). Entries
batch per frame across the boundary; values cross as structured-clone-safe
previews (cosignals-first-draft's packed ring can ship raw and decode panel-side later).
The panel is transport-agnostic — the inline host wires the same components to
an in-realm `Backend`.

### Sequencing

0. **`protocol/` + a replay harness** — drive the whole UI from a recorded
   fx2 trace fixture, no live engine, no browser. Deterministic UI work; also
   the anti-over-fit check.
1. **fx2 adapter + collector** against the fx2 playground; add the few emit
   points; confirm the two unknowns.
2. **`panel/` + inline host** — mockups → components on the live collector.
   The demoable milestone.
3. **Chrome extension shell** — page hook + content-script bridge.
4. **Second adapter (cosignals-first-draft) + copy-as-markdown serializer** — proves the
   protocol isn't fx2-shaped and lands the AI handoff.
