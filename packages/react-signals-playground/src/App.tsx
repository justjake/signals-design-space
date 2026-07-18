/**
 * The one demo app, shared verbatim by every entrypoint. Everything
 * reactive comes from '#engine' — this file never names a concrete
 * engine package, so the same tree exercises whichever engine the
 * current page selected. Both engines export the identical cosignals
 * API, so the code below is exactly what a cosignals app looks like.
 *
 * The app is a transitions lab shaped like a tiny browser: an inner history
 * stack with back/forward and a virtual address bar, where every navigation
 * runs inside startSignalTransition and suspends on a fake fetch until the
 * destination's data arrives. The latency knob decides when that is — up to
 * "hold", which keeps the transition open until RELEASE is pressed — so
 * urgent updates (counter, clock, filter) can be interleaved against a
 * pending transition deliberately and watched on the timeline strip.
 */
import * as React from "react"
import {
  createAtom,
  createComputed,
  implementationHref,
  implementations,
  name,
  startSignalTransition,
  useComputed,
  useSignal,
  useSignalEffect,
} from "#engine"
import { maybeWrapThenable, recordFetch, registerAppHandles, TEST_MODE, TestPanel } from "./testkit"
import {
  BenchIntro,
  EngineNotes,
  Hero,
  Primitives,
  StressIntro,
  TransitionsIntro,
  WhatAreSignals,
} from "./site"
import { StressField } from "./field/StressField"
import { BenchSection } from "./bench/BenchSection"

// ---- module-level store -----------------------------------------------------------
// Created at module init, before main.tsx renders anything: every engine
// allocates signal records without touching React, so creation-time order is
// safe. Shared by every component below.

const count = createAtom(0, { label: "count" })
const doubled = createComputed(() => count.get() * 2, { label: "doubled" })
const parity = createComputed(() => (count.get() % 2 === 0 ? "even" : "odd"), { label: "parity" })

// A deliberately-throwing computed, armed from a button, so the devtools'
// errored-node UI (and "errored at") can be exercised. Reading it throws while
// armed; an error boundary below keeps the app alive.
const errorArmed = createAtom(false, { label: "errorArmed" })
const errorBoom = createComputed(
  () => {
    if (errorArmed.get()) throw new Error("deliberate error for devtools testing")
    return count.get()
  },
  { label: "errorBoom" },
)

/**
 * A suspending computed, toggled from a button, so the devtools'
 * suspended-node UI (and "suspended at") can be exercised. While parked its
 * node carries the engine's suspended flag: `toggle` parks it on a fresh
 * pending promise (bumping `epoch` re-runs the body so it re-parks) and,
 * called again, resolves that promise so the body reruns to 'loaded'.
 */
function createSuspendingFixture() {
  const epoch = createAtom(0, { label: "asyncEpoch" })
  const pending = createAtom(false, { label: "asyncPending" })
  let deferred: { promise: Promise<void>; resolve: () => void } | undefined
  const value = createComputed<string>(
    (use) => {
      epoch.get()
      if (deferred === undefined) return "idle"
      use(deferred.promise)
      return "loaded"
    },
    { label: "asyncData" },
  )
  return {
    pending,
    value,
    toggle(): void {
      if (pending.get()) {
        deferred?.resolve()
        pending.set(false)
        return
      }
      let resolve!: () => void
      deferred = { promise: new Promise<void>((r) => (resolve = r)), resolve }
      pending.set(true)
      epoch.update((e) => e + 1)
    },
  }
}
const asyncFixture = createSuspendingFixture()

// The urgent clock: an interval-driven signal. Its continued ticking while a
// transition is held open is direct visual proof the committed tree stays
// live and keeps committing urgent updates.
const CLOCK_TICK_MS = TEST_MODE ? 100 : 10_000
const clockMs = createAtom(Math.round(performance.now()), { label: "clockMs" })
let clockTimer = window.setInterval(() => clockMs.set(Math.round(performance.now())), CLOCK_TICK_MS)

// ---- inner navigation (the mini-browser) -------------------------------------------
// Every navigation gets a fresh epoch. The target pair is written urgently
// (address bar and pending flag answer immediately); the current pair is
// written inside startSignalTransition and only commits when the destination
// finishes rendering — which, because the destination suspends on its data
// resource, is when the fake fetch resolves. Epoch disagreement IS the
// pending flag: the useTransition-equivalent state, derived from app state
// alone.

type RouteName = "dashboard" | "table" | "detail"
const ROUTES: readonly RouteName[] = ["dashboard", "table", "detail"]

const targetRoute = createAtom<RouteName>("dashboard", { label: "targetRoute" })
const targetEpoch = createAtom(0, { label: "targetEpoch" })
const currentRoute = createAtom<RouteName>("dashboard", { label: "currentRoute" })
const routeEpoch = createAtom(0, { label: "routeEpoch" })
const navPending = createComputed(() => targetEpoch.get() !== routeEpoch.get(), {
  label: "navPending",
})

const histEntries = createAtom<readonly RouteName[]>(["dashboard"], { label: "histEntries" })
const histIndex = createAtom(0, { label: "histIndex" })

function addressOf(route: RouteName): string {
  return `app://lab/${route}`
}

// ---- navigation data resources -------------------------------------------------------
// The fake fetch: one keyed resource per navigation, created when the
// navigation starts (fetch-on-navigate, never during render). The
// destination view reads its epoch's resource and throws the promise while
// pending — React Suspense then holds the whole transition open until the
// data arrives, which is the mechanism a real app's loaders would use. The
// latency knob controls resolution; 'hold' parks the resource until the
// RELEASE button settles it.

type NavLatency = 0 | 250 | 1000 | 3000 | "hold"
const NAV_LATENCIES: readonly { value: NavLatency; label: string }[] = [
  { value: 0, label: "instant" },
  { value: 250, label: "250 ms" },
  { value: 1000, label: "1 s" },
  { value: 3000, label: "3 s" },
  { value: "hold", label: "hold" },
]
const navLatency = createAtom<NavLatency>(250, { label: "navLatency" })
const heldCount = createAtom(0, { label: "heldCount" })

interface RouteResource {
  readonly epoch: number
  readonly route: RouteName
  status: "pending" | "ready"
  /** Fetch duration, filled at settle. */
  arrivedInMs: number
  readonly startedAt: number
  readonly promise: Promise<void>
  /**
   * What a pending read throws. Normally the promise itself; in the
   * battery's foreign-thenable mode a non-Promise thenable wrapping it —
   * created once here so re-renders re-throw the same reference.
   */
  readonly thrown: PromiseLike<void>
  settle(): void
}

const resources = new Map<number, RouteResource>()
let heldResources: RouteResource[] = []

function createRouteResource(epoch: number, route: RouteName, latency: NavLatency): void {
  let resolvePromise!: () => void
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  const resource: RouteResource = {
    epoch,
    route,
    status: "pending",
    arrivedInMs: 0,
    startedAt: performance.now(),
    promise,
    thrown: maybeWrapThenable(promise),
    settle() {
      if (resource.status === "ready") {
        return
      }
      resource.status = "ready"
      resource.arrivedInMs = Math.round(performance.now() - resource.startedAt)
      recordFetch(epoch, route, "settle")
      resolvePromise()
    },
  }
  resources.set(epoch, resource)
  recordFetch(epoch, route, "create")
  if (latency === "hold") {
    heldResources.push(resource)
    heldCount.update((n) => n + 1)
  } else if (latency === 0) {
    resource.settle() // ready before any render sees it: pure sync-weight mode
  } else {
    window.setTimeout(() => resource.settle(), latency)
  }
}

// The initial route's data is part of the initial page: first paint never suspends.
createRouteResource(0, "dashboard", 0)

function releaseHeld(): void {
  const held = heldResources
  heldResources = []
  heldCount.set(0)
  for (const resource of held) {
    resource.settle()
  }
}

/** Render-phase read of a navigation's data; throws the promise while pending (Suspense). */
function readRouteData(epoch: number): RouteResource {
  const resource = resources.get(epoch)
  if (resource === undefined) {
    throw new Error(`react-signals-playground: no data resource for navigation #${epoch}`)
  }
  if (resource.status === "pending") {
    throw resource.thrown
  }
  return resource
}

/** Committed navigations can never be read again; drop everything older. */
function pruneResources(settledEpoch: number): void {
  for (const epoch of resources.keys()) {
    if (epoch < settledEpoch) {
      resources.delete(epoch)
    }
  }
}

// ---- transition timeline --------------------------------------------------------------
// One record per navigation: when it started, how long it stayed pending,
// and the offsets of interactive urgent commits that landed inside the
// pending window (the interleaving evidence). The active record grows on the
// live bar; settled records keep the last few.

interface NavRecord {
  readonly epoch: number
  readonly route: RouteName
  readonly startedAt: number
  /** null while the navigation is still pending. */
  readonly durationMs: number | null
  /** True when a newer navigation replaced this one before it settled. */
  readonly superseded: boolean
  /** ms offsets from startedAt of urgent commits that landed while pending. */
  readonly ticks: readonly number[]
}

const NAV_LOG_LINES = 5
const activeNav = createAtom<NavRecord | null>(null, { label: "activeNav" })
const navLog = createAtom<readonly NavRecord[]>([], { label: "navLog" })

function recordUrgentTick(): void {
  const record = activeNav.get()
  if (record === null) {
    return
  }
  const offset = Math.round(performance.now() - record.startedAt)
  activeNav.update((r) => (r === null ? r : { ...r, ticks: [...r.ticks, offset] }))
}

function closeNavRecord(record: NavRecord, superseded: boolean): void {
  const durationMs = Math.round(performance.now() - record.startedAt)
  navLog.update((log) => [...log, { ...record, durationMs, superseded }].slice(-NAV_LOG_LINES))
}

// ---- navigate -----------------------------------------------------------------------------

let navSeq = 0

function navigate(route: RouteName, pushHistory: boolean): void {
  const epoch = ++navSeq
  createRouteResource(epoch, route, navLatency.get())
  const superseded = activeNav.get()
  if (superseded !== null) {
    closeNavRecord(superseded, true)
  }
  if (pushHistory) {
    const index = histIndex.get()
    histEntries.update((entries) => [...entries.slice(0, index + 1), route])
    histIndex.set(index + 1)
  }
  // Urgent: the chrome answers now — address bar, pending flag, timeline.
  targetRoute.set(route)
  targetEpoch.set(epoch)
  activeNav.set({
    epoch,
    route,
    startedAt: performance.now(),
    durationMs: null,
    superseded: false,
    ticks: [],
  })
  // The destination suspends on its resource inside this transition, so
  // the transition itself stays open until the data arrives.
  startSignalTransition(() => {
    currentRoute.set(route)
    routeEpoch.set(epoch)
  })
}

function goBack(): void {
  const index = histIndex.get()
  if (index <= 0) {
    return
  }
  histIndex.set(index - 1)
  navigate(histEntries.get()[index - 1], false)
}

function goForward(): void {
  const index = histIndex.get()
  const entries = histEntries.get()
  if (index >= entries.length - 1) {
    return
  }
  histIndex.set(index + 1)
  navigate(entries[index + 1], false)
}

// ---- table data ---------------------------------------------------------------------

const INITIAL_ROWS = 3000
const ROW_STEP = 500
const rowCount = createAtom(INITIAL_ROWS, { label: "rowCount" })
const tableSeed = createAtom(1, { label: "tableSeed" })
const filterText = createAtom("", { label: "filterText" })
const selectedRow = createAtom(0, { label: "selectedRow" })
const markEvens = createAtom(false, { label: "markEvens" })

// Sync render weight, as distinct from the async data hold above: extra hash
// rounds per row derivation make every table render pass proportionally more
// expensive, which exercises time-slicing rather than Suspense.
const CPU_WORK: readonly { rounds: number; label: string }[] = [
  { rounds: 1, label: "off" },
  { rounds: 64, label: "light" },
  { rounds: 1024, label: "medium" },
  { rounds: 8192, label: "heavy" },
]
const cpuRounds = createAtom(64, { label: "cpuRounds" })

/**
 * Deterministic per-row hash: every seed change visibly changes every row,
 * so one reseed re-derives the whole table. `rounds` is the CPU-work knob.
 */
function rowValue(seed: number, index: number, rounds: number): number {
  let h = Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35)
  for (let round = 0; round < rounds; round++) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ round
  }
  return (h >>> 0) % 100000
}

/**
 * Fixed-width row text: filtering matches what the chip displays, and equal
 * widths keep the table grid from shifting as values change.
 */
function rowText(value: number): string {
  return String(value).padStart(5, "0")
}

function visibleRowsOf(seed: number, total: number, filter: string, rounds: number): number[] {
  const out: number[] = []
  for (let index = 0; index < total; index++) {
    if (rowText(rowValue(seed, index, rounds)).includes(filter)) {
      out.push(index)
    }
  }
  return out
}

const visibleRows = createComputed(
  () => visibleRowsOf(tableSeed.get(), rowCount.get(), filterText.get(), cpuRounds.get()),
  { label: "visibleRows" },
)
// The same question derived independently from the same atoms: any render
// that mixes worlds (rows from one write, count from another) disagrees.
const visibleCount = createComputed(
  () => visibleRowsOf(tableSeed.get(), rowCount.get(), filterText.get(), cpuRounds.get()).length,
  { label: "visibleCount" },
)

// Engine-internal coherence oracle: one computation reads several signals
// that must always agree, so a single evaluation can never observe a mix.
const consistency = createComputed(
  () =>
    doubled.get() === count.get() * 2 && visibleRows.get().length === visibleCount.get()
      ? "consistent"
      : "TORN",
  { label: "consistency" },
)

const tornCommits = createAtom(0, { label: "tornCommits" })

// The battery's label registry: every shared atom the tests read or write
// from outside any render (window.__store) is registered once, here.
registerAppHandles({
  count,
  doubled,
  parity,
  clockMs,
  targetRoute,
  targetEpoch,
  currentRoute,
  routeEpoch,
  navPending,
  navLatency,
  heldCount,
  rowCount,
  tableSeed,
  filterText,
  selectedRow,
  markEvens,
  cpuRounds,
  visibleCount,
  consistency,
  tornCommits,
})

// ---- error strip ----------------------------------------------------------------------

const ERROR_LINES = 5
const errorLog = createAtom<readonly string[]>([], { label: "errorLog" })

function logError(line: string): void {
  errorLog.update((log) => [...log, line].slice(-ERROR_LINES))
}

// Module init runs once per page: page-level failures land in the strip.
window.addEventListener("error", (event) => logError(`error: ${event.message}`))
window.addEventListener("unhandledrejection", (event) =>
  logError(`unhandled rejection: ${String(event.reason)}`),
)

// ---- committed-render tally --------------------------------------------------------
// Passive effects only run for renders React committed, so an every-render
// effect in each section component counts committed renders and never counts
// discarded speculative passes. The tile updates imperatively: routing the
// tally through a signal would re-render the tree the tally measures. The
// clock deliberately does not tally — its faster test-mode cadence would
// drown the interaction signal this tile exists to show.

let committedRenders = 0
let committedRendersEl: HTMLElement | null = null

function useCommittedRenderTally(): void {
  React.useEffect(() => {
    committedRenders += 1
    if (committedRendersEl !== null) {
      committedRendersEl.textContent = String(committedRenders)
    }
  })
}

/**
 * Drops a tick on the live timeline bar when a commit lands while a
 * navigation is pending and any of `deps` changed in it — called by the
 * interactive urgent widgets, so the ticks are the interleaving evidence.
 */
function useUrgentCommitTick(deps: readonly unknown[]): void {
  const first = React.useRef(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    recordUrgentTick()
  }, deps)
}

// ---- consistency (render-level) ------------------------------------------------------

/**
 * The cross-hook tearing check: each useSignal call subscribes and resolves
 * independently, so values that must agree are read through separate hooks
 * and compared in render. This is the check the engine-internal oracle
 * cannot do — a bridge that resolves two hooks in two worlds within one
 * render passes the oracle and fails here.
 */
function useConsistencyVerdict(): "consistent" | "TORN" {
  const value = useSignal(count)
  const twice = useSignal(doubled)
  const rows = useSignal(visibleRows)
  const expected = useSignal(visibleCount)
  const oracle = useSignal(consistency)
  const agree = twice === value * 2 && rows.length === expected && oracle === "consistent"
  return agree ? "consistent" : "TORN"
}

// ---- chrome ---------------------------------------------------------------------------

function ImplTabs(): React.ReactElement {
  // Full-page navigations by design: each entry is its own module graph
  // (one engine per page), so a client-side switch cannot swap engines.
  return (
    <nav className="tabbar" aria-label="implementation">
      {implementations.map((impl) => (
        <a
          key={impl.segment}
          href={implementationHref(impl)}
          className={impl.name === name ? "on" : undefined}
          data-testid={`impl-tab-${impl.label}`}
        >
          {impl.label}
        </a>
      ))}
    </nav>
  )
}

function Stat(props: { id: string; label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="stat" id={props.id}>
      <span>{props.children}</span>
      <label>{props.label}</label>
    </div>
  )
}

/** Its own component so clock ticks re-render this tile alone, not the panel. */
function ClockTile(): React.ReactElement {
  const now = useSignal(clockMs)
  const [paused, setPaused] = React.useState(false)
  return (
    <Stat id="stat-clock" label="urgent clock">
      <span className="now" data-testid="clock">
        {(now / 1000).toFixed(1)}s
      </span>
      <button
        type="button"
        className="clock-toggle"
        onClick={() => {
          if (paused) {
            clockMs.set(Math.round(performance.now()))
            clockTimer = window.setInterval(
              () => clockMs.set(Math.round(performance.now())),
              CLOCK_TICK_MS,
            )
          } else {
            window.clearInterval(clockTimer)
          }
          setPaused(!paused)
        }}
      >
        {paused ? "resume" : "pause"}
      </button>
    </Stat>
  )
}

function StatsPanel(): React.ReactElement {
  useCommittedRenderTally()
  const route = useSignal(currentRoute)
  const target = useSignal(targetRoute)
  const pending = useSignal(navPending)
  const log = useSignal(navLog)
  const verdict = useConsistencyVerdict()
  const torn = useSignal(tornCommits)
  const lastSettled = [...log].reverse().find((record) => !record.superseded)

  // Committed-world side effects: the title and the timeline settle
  // tracking follow what the user actually sees, so they lag pending
  // transitions instead of revealing them early. Reads that re-run the
  // effect live in the watch source; the record bookkeeping (reads and
  // writes alike) is the run handler's.
  useSignalEffect(
    () => ({
      watch: currentRoute,
      run: (route) => {
        document.title = `${name} · ${route}`
      },
    }),
    [],
  )
  useSignalEffect(
    () => ({
      watch: routeEpoch, // fires when a navigation commits
      run: (settledEpoch) => {
        const record = activeNav.get()
        if (record !== null && record.epoch <= settledEpoch) {
          closeNavRecord(record, false)
          activeNav.set(null)
        }
        pruneResources(settledEpoch)
      },
    }),
    [],
  )

  // A TORN verdict on committed UI is an integrity failure: latch it (the
  // tile survives the frame that tore) and put it in the error strip.
  React.useEffect(() => {
    if (verdict === "TORN") {
      tornCommits.update((n) => n + 1)
      logError(`torn commit: cross-hook reads disagreed while showing "${route}"`)
    }
  }, [verdict, route])

  return (
    <section id="hud" aria-label="instrumentation">
      <Stat id="stat-impl" label="implementation">
        <span className="now" data-testid="impl-name">
          {name}
        </span>
      </Stat>
      <ClockTile />
      <Stat id="stat-view" label="committed route">
        <span className="now" data-testid="view-name">
          {route}
        </span>
        <span className="avg" data-testid="view-target">
          {pending ? ` → ${target}` : ""}
        </span>
      </Stat>
      <Stat id="stat-pending" label="transition pending">
        <span className={pending ? "now is-pending" : "now"} data-testid="pending">
          {pending ? "yes" : "no"}
        </span>
      </Stat>
      <Stat id="stat-switch" label="last navigation">
        <span className="now" data-testid="last-nav-ms">
          {lastSettled === undefined ? "–" : `${lastSettled.durationMs} ms`}
        </span>
      </Stat>
      <Stat id="stat-renders" label="committed renders">
        <span
          className="now"
          data-testid="renders-committed"
          ref={(el) => {
            committedRendersEl = el
            if (el !== null) {
              el.textContent = String(committedRenders)
            }
          }}
        />
      </Stat>
      <Stat id="stat-consistency" label="consistency">
        <span
          className={verdict === "consistent" ? "now is-ok" : "now is-torn"}
          data-testid="consistency"
        >
          {verdict}
        </span>
        <span className="avg" data-testid="torn-count">
          {` torn ${torn}`}
        </span>
      </Stat>
    </section>
  )
}

// ---- urgent controls ------------------------------------------------------------------
// "Normal app stuff": every handler here writes urgently (no transition), so
// these must commit immediately even while a navigation is held open.

// Reads the throwing computed; the boundary catches its throw while armed so
// the errored node shows in the devtools without taking the page down.
function BoomReader(): React.ReactElement {
  return <span data-testid="boom-value">{String(useSignal(errorBoom))}</span>
}
class BoomBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): React.ReactNode {
    return this.state.failed ? (
      <span data-testid="boom-caught">⚠ errored</span>
    ) : (
      this.props.children
    )
  }
}

// Reads the suspending computed; while parked its node throws to the Suspense
// boundary below, so the suspended node (and "suspended at") shows in devtools.
function AsyncReader(): React.ReactElement {
  return <span data-testid="async-value">{useSignal(asyncFixture.value)}</span>
}
function AsyncControls(): React.ReactElement {
  const pending = useSignal(asyncFixture.pending)
  // The reader stays mounted so asyncData settles a value ('idle') up front.
  // A later suspend then parks a node that already has a value, so devtools
  // shows that stale value (stale-while-revalidate) rather than
  // "uninitialized". The Suspense boundary only catches a never-yet-resolved
  // read, which this flow no longer produces.
  return (
    <>
      <button
        type="button"
        data-testid="arm-async"
        className={pending ? "on" : undefined}
        aria-pressed={pending}
        onClick={() => asyncFixture.toggle()}
      >
        {pending ? "resolve async" : "suspend async"}
      </button>
      <span className="cell">
        <label>async</label>
        <React.Suspense fallback={<span data-testid="async-fallback">loading…</span>}>
          <AsyncReader />
        </React.Suspense>
      </span>
    </>
  )
}

function Controls(): React.ReactElement {
  useCommittedRenderTally()
  const value = useSignal(count)
  const evens = useSignal(markEvens)
  const filter = useSignal(filterText)
  const total = useSignal(rowCount)
  const armed = useSignal(errorArmed)
  useUrgentCommitTick([value, evens, filter, total])
  // A signal effect reacting to the urgent counter, so effect nodes/events show
  // up as soon as you click +1 (the nav effects only fire on navigation).
  useSignalEffect(
    () => ({
      watch: count,
      run: (c) => {
        document.documentElement.dataset.devtoolsCount = String(c)
      },
    }),
    [],
  )

  return (
    <section id="controls" aria-label="urgent controls">
      <div className="cell">
        <label>count</label>
        <output data-testid="count">{value}</output>
      </div>
      <button type="button" data-testid="increment" onClick={() => count.update((c) => c + 1)}>
        +1 urgent
      </button>
      <button
        type="button"
        data-testid="increment-transition"
        onClick={() => startSignalTransition(() => count.update((c) => c + 10))}
      >
        +10 in transition
      </button>
      <button
        type="button"
        data-testid="arm-error"
        className={armed ? "on" : undefined}
        aria-pressed={armed}
        onClick={() => errorArmed.update((a) => !a)}
      >
        {armed ? "error armed" : "arm error"}
      </button>
      <span className="cell">
        <label>boom</label>
        {/* Remount on toggle so disarming clears the boundary's caught state. */}
        <BoomBoundary key={armed ? "armed" : "ok"}>
          <BoomReader />
        </BoomBoundary>
      </span>
      <AsyncControls />
      <button
        type="button"
        data-testid="toggle-evens"
        className={evens ? "on" : undefined}
        aria-pressed={evens}
        onClick={() => markEvens.update((on) => !on)}
      >
        {evens ? "evens marked" : "mark evens"}
      </button>
      <input
        type="text"
        data-testid="filter-input"
        placeholder="filter rows…"
        value={filter}
        onChange={(event) => filterText.set(event.target.value)}
      />
      <button
        type="button"
        data-testid="add-rows"
        onClick={() => rowCount.update((n) => n + ROW_STEP)}
      >
        +{ROW_STEP} rows
      </button>
      <button
        type="button"
        data-testid="remove-rows"
        onClick={() => rowCount.update((n) => Math.max(ROW_STEP, n - ROW_STEP))}
      >
        −{ROW_STEP} rows
      </button>
      <span className="note" data-testid="row-total">
        {total} rows
      </span>
    </section>
  )
}

// ---- transition lab -----------------------------------------------------------------

function LabPanel(): React.ReactElement {
  useCommittedRenderTally()
  const latency = useSignal(navLatency)
  const rounds = useSignal(cpuRounds)
  return (
    <section className="lab" aria-label="transition lab">
      <div className="knob">
        <label>navigation latency</label>
        <span className="libpick">
          {NAV_LATENCIES.map((option) => (
            <button
              key={option.label}
              type="button"
              data-testid={`latency-${option.label.replace(" ", "")}`}
              className={latency === option.value ? "on" : undefined}
              onClick={() => navLatency.set(option.value)}
            >
              {option.label}
            </button>
          ))}
        </span>
      </div>
      <div className="knob">
        <label>row computation</label>
        <span className="libpick">
          {CPU_WORK.map((option) => (
            <button
              key={option.label}
              type="button"
              data-testid={`cpu-${option.label}`}
              className={rounds === option.rounds ? "on" : undefined}
              onClick={() => startSignalTransition(() => cpuRounds.set(option.rounds))}
            >
              {option.label}
            </button>
          ))}
        </span>
      </div>
      <p className="hint">
        Navigation latency delays the fake request. "hold" waits until you press release. Row
        computation adds work to each derived table row.
      </p>
    </section>
  )
}

// ---- the mini-browser -----------------------------------------------------------------

function BrowserChrome(): React.ReactElement {
  useCommittedRenderTally()
  const route = useSignal(currentRoute)
  const target = useSignal(targetRoute)
  const pending = useSignal(navPending)
  const held = useSignal(heldCount)
  const index = useSignal(histIndex)
  const entries = useSignal(histEntries)

  return (
    <section className="browser" aria-label="mini browser">
      <div className="browser-toolbar">
        <button
          type="button"
          className="navbtn"
          data-testid="back"
          disabled={index <= 0}
          onClick={goBack}
          aria-label="back"
        >
          ◀
        </button>
        <button
          type="button"
          className="navbtn"
          data-testid="forward"
          disabled={index >= entries.length - 1}
          onClick={goForward}
          aria-label="forward"
        >
          ▶
        </button>
        {/* While pending the address shows WHERE WE ARE GOING with a
				    shimmer, like a real browser mid-load; the page below keeps
				    showing where we still are. */}
        <span className={pending ? "addr loading" : "addr"} data-testid="addr">
          {addressOf(pending ? target : route)}
        </span>
        <button
          type="button"
          className={held > 0 ? "release lit" : "release"}
          data-testid="release"
          disabled={held === 0}
          onClick={releaseHeld}
        >
          release{held > 0 ? ` (${held})` : ""}
        </button>
      </div>
      <nav className="bookmarks" aria-label="bookmarks">
        {ROUTES.map((r) => {
          const cls = route === r ? "on" : pending && target === r ? "pending" : undefined
          return (
            <button
              key={r}
              type="button"
              className={cls}
              data-testid={`view-tab-${r}`}
              onClick={() => navigate(r, true)}
            >
              {r}
            </button>
          )
        })}
      </nav>
      <div className={pending ? "browser-page stale" : "browser-page"}>
        <React.Suspense fallback={<div className="pageload">loading…</div>}>
          <PageArea />
        </React.Suspense>
      </div>
    </section>
  )
}

function PageArea(): React.ReactElement {
  useCommittedRenderTally()
  const route = useSignal(currentRoute)
  const epoch = useSignal(routeEpoch)
  // Suspends while this navigation's data is in flight: inside a transition
  // render that means the transition itself stays open (committed UI keeps
  // the previous page); on a cold mount it means the Suspense fallback.
  const data = readRouteData(epoch)
  return (
    <div data-testid="view-panel" data-view={route}>
      <p className="pagemeta">
        <span data-testid="data-epoch">nav #{epoch}</span> · data arrived in {data.arrivedInMs} ms
      </p>
      {route === "dashboard" ? <Dashboard /> : route === "table" ? <TableView /> : <DetailView />}
    </div>
  )
}

// ---- pages ------------------------------------------------------------------------------

function Dashboard(): React.ReactElement {
  useCommittedRenderTally()
  const value = useSignal(count)
  const twice = useSignal(doubled)
  const parityText = useSignal(parity)
  const [factor, setFactor] = React.useState(3)
  // Component-scoped derived value: `factor` is ordinary React state, so it
  // belongs in deps; the count read is tracked by the engine, not by deps.
  const scaled = useComputed(() => count.get() * factor, [factor])

  return (
    <div>
      <p className="viewlede">
        These values derive from the shared <code>count</code> atom. Use the controls above to
        update it urgently or in a transition.
      </p>
      <div className="cells">
        <div className="cell">
          <label>count</label>
          <output data-testid="dash-count">{value}</output>
        </div>
        <div className="cell">
          <label>doubled</label>
          <output data-testid="doubled">{twice}</output>
        </div>
        <div className="cell">
          <label>parity</label>
          <output data-testid="parity">{parityText}</output>
        </div>
        <div className="cell">
          <label>count × {factor}</label>
          <output data-testid="scaled">{scaled}</output>
        </div>
      </div>
      <div className="actions">
        <button type="button" data-testid="factor-up" onClick={() => setFactor((f) => f + 1)}>
          factor +1
        </button>
      </div>
    </div>
  )
}

function Row({ index }: { index: number }): React.ReactElement {
  const value = useComputed(() => rowValue(tableSeed.get(), index, cpuRounds.get()), [index])
  const selected = useComputed(() => selectedRow.get() === index, [index])
  return (
    <li
      className={selected ? "rowchip sel" : "rowchip"}
      data-even={value % 2 === 0 ? "" : undefined}
      data-testid={index === 0 ? "row-0" : undefined}
    >
      {rowText(value)}
    </li>
  )
}

function TableView(): React.ReactElement {
  useCommittedRenderTally()
  const rows = useSignal(visibleRows)
  const total = useSignal(rowCount)
  const seed = useSignal(tableSeed)
  const evens = useSignal(markEvens)
  return (
    <div>
      <p className="viewlede">
        <span data-testid="row-visible">{rows.length}</span> of {total} rows visible · seed{" "}
        <span data-testid="seed">{seed}</span> · each row has its own computed value.
      </p>
      <div className="actions">
        <button
          type="button"
          data-testid="reseed-transition"
          onClick={() => startSignalTransition(() => tableSeed.update((s) => s + 1))}
        >
          reseed in transition
        </button>
        <button
          type="button"
          data-testid="reseed-urgent"
          onClick={() => tableSeed.update((s) => s + 1)}
        >
          reseed urgent
        </button>
      </div>
      <ol className={evens ? "rowgrid mark-evens" : "rowgrid"}>
        {rows.map((index) => (
          <Row key={index} index={index} />
        ))}
      </ol>
    </div>
  )
}

const DETAIL_SEED_LOOKAHEAD = 12
const DETAIL_NEIGHBORS = 12 // each side of the selected row

function DetailView(): React.ReactElement {
  useCommittedRenderTally()
  const index = useSignal(selectedRow)
  const total = useSignal(rowCount)
  const seed = useSignal(tableSeed)
  useUrgentCommitTick([index])
  const value = useComputed(() => rowValue(tableSeed.get(), index, cpuRounds.get()), [index])
  // A window of neighbors and a look-ahead across future seeds: enough
  // derived cells to make this page mid-weight (heavier than the dashboard,
  // far lighter than the table).
  const neighbors = useComputed(() => {
    const from = Math.max(0, index - DETAIL_NEIGHBORS)
    const to = Math.min(total - 1, index + DETAIL_NEIGHBORS)
    const out: { index: number; value: number }[] = []
    for (let i = from; i <= to; i++) {
      out.push({ index: i, value: rowValue(tableSeed.get(), i, cpuRounds.get()) })
    }
    return out
  }, [index, total])
  const lookahead = useComputed(() => {
    const out: { seed: number; value: number }[] = []
    for (let k = 0; k < DETAIL_SEED_LOOKAHEAD; k++) {
      out.push({
        seed: tableSeed.get() + k,
        value: rowValue(tableSeed.get() + k, index, cpuRounds.get()),
      })
    }
    return out
  }, [index])

  return (
    <div>
      <p className="viewlede">
        The selected row under the current seed, beside its neighbors and its next{" "}
        {DETAIL_SEED_LOOKAHEAD} values.
      </p>
      <div className="cells">
        <div className="cell">
          <label>row</label>
          <output data-testid="detail-index">{index}</output>
        </div>
        <div className="cell">
          <label>value @ seed {seed}</label>
          <output data-testid="detail-value">{rowText(value)}</output>
        </div>
      </div>
      <div className="actions">
        <button
          type="button"
          data-testid="detail-prev"
          onClick={() => selectedRow.update((i) => Math.max(0, i - 1))}
        >
          prev row
        </button>
        <button
          type="button"
          data-testid="detail-next"
          onClick={() => selectedRow.update((i) => i + 1)}
        >
          next row
        </button>
      </div>
      <h3>neighbors</h3>
      <ol className="rowgrid">
        {neighbors.map((n) => (
          <li key={n.index} className={n.index === index ? "rowchip sel" : "rowchip"}>
            {rowText(n.value)}
          </li>
        ))}
      </ol>
      <h3>seed look-ahead</h3>
      <ol className="rowgrid">
        {lookahead.map((entry) => (
          <li key={entry.seed} className="rowchip alt">
            {rowText(entry.value)}
          </li>
        ))}
      </ol>
    </div>
  )
}

// ---- transition timeline strip -----------------------------------------------------------

const TIMELINE_WINDOW_MS = 5000

function timelineWidthPct(ms: number): number {
  return Math.min(ms / TIMELINE_WINDOW_MS, 1) * 100
}

function TimelineBar(props: {
  route: RouteName
  elapsedMs: number
  ticks: readonly number[]
  live: boolean
  superseded: boolean
}): React.ReactElement {
  const fillClass = props.live ? "t-fill live" : props.superseded ? "t-fill superseded" : "t-fill"
  return (
    <div className="t-row" data-testid={props.live ? "timeline-live" : "timeline-record"}>
      <span className="t-route">{props.route}</span>
      <span className="t-bar">
        <span className={fillClass} style={{ width: `${timelineWidthPct(props.elapsedMs)}%` }} />
        {props.ticks.map((tick, i) => (
          <span key={i} className="t-tick" style={{ left: `${timelineWidthPct(tick)}%` }} />
        ))}
      </span>
      <span className="t-meta" data-testid={props.live ? "timeline-live-ms" : undefined}>
        {props.elapsedMs} ms · {props.ticks.length} urgent{props.superseded ? " · superseded" : ""}
      </span>
    </div>
  )
}

/** Its own component: clock ticks grow only the live bar, not the history. */
function TimelineLiveBar(): React.ReactElement | null {
  const record = useSignal(activeNav)
  const now = useSignal(clockMs)
  if (record === null) {
    return null
  }
  return (
    <TimelineBar
      route={record.route}
      elapsedMs={Math.max(0, Math.round(now - record.startedAt))}
      ticks={record.ticks}
      live
      superseded={false}
    />
  )
}

function TimelineStrip(): React.ReactElement {
  useCommittedRenderTally()
  const log = useSignal(navLog)
  return (
    <section className="timeline" aria-label="transition timeline">
      <h3>
        transition timeline{" "}
        <span className="hint-inline">
          5 s scale · amber ticks mark urgent commits during the transition
        </span>
      </h3>
      <TimelineLiveBar />
      {[...log].reverse().map((record) => (
        <TimelineBar
          key={record.epoch}
          route={record.route}
          elapsedMs={record.durationMs ?? 0}
          ticks={record.ticks}
          live={false}
          superseded={record.superseded}
        />
      ))}
    </section>
  )
}

function ErrorStrip(): React.ReactElement | null {
  const lines = useSignal(errorLog)
  if (lines.length === 0) {
    return null
  }
  return (
    <section id="errors" aria-label="errors" data-testid="errors">
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </section>
  )
}

/** The transitions lab: HUD, urgent controls, knobs, mini-browser, timeline. */
function TransitionsLab(): React.ReactElement {
  return (
    <>
      <StatsPanel />
      <Controls />
      <LabPanel />
      <BrowserChrome />
      <TimelineStrip />
    </>
  )
}

export function App(): React.ReactElement {
  // Under ?test=1 the page is a fixture: just the lab and the test panel,
  // with none of the explainer content or on-demand demos, so the battery
  // measures the engines rather than the site.
  if (TEST_MODE) {
    return (
      <main>
        <div className="topnav">
          <ImplTabs />
        </div>
        <TransitionsLab />
        <ErrorStrip />
        <TestPanel />
      </main>
    )
  }
  return (
    <main>
      <div className="topnav">
        <span className="topnav-title">signals, two ways</span>
        <ImplTabs />
      </div>
      <Hero />
      <WhatAreSignals />
      <Primitives />
      <TransitionsIntro />
      <TransitionsLab />
      <StressIntro />
      <StressField />
      <BenchIntro />
      <BenchSection />
      <EngineNotes />
      <ErrorStrip />
    </main>
  )
}
