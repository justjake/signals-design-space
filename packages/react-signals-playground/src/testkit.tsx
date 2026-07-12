/**
 * Test-mode instrumentation, active only when the page URL carries ?test=1.
 * The battery (battery/) drives everything here; the testid and
 * window.__store surfaces are a versioned contract documented in
 * battery/TESTIDS.md — change them there first.
 *
 * Two rules this file inherits from the app and must keep:
 * - Verdicts latch via effects, so discarded speculative render passes never
 *   count as torn: every "did this frame agree" check runs in a layout
 *   effect of the committed frame, never in render.
 * - update(fn) fixtures stay pure: implementations replay updaters per
 *   pending world, so every updater here is a pure function of its argument.
 *
 * The file imports only the shim and React — never App.tsx. App.tsx passes
 * its module-level atoms in through registerAppHandles at module init, so
 * there is exactly one dependency direction.
 */
import * as React from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import {
	createAtom,
	name,
	startSignalTransition,
	transitionHoldStyle,
	useSignal,
	useSignalEffect,
	type ReadableSignal,
	type TransitionHoldStyle,
	type WritableSignal,
} from '#concurrent-signals-shim'

export const TEST_MODE = new URLSearchParams(window.location.search).has('test')

// ---- log entry shapes (shared with battery/helpers.ts as types) ---------------------

export interface EffectLogEntry {
	/** performance.now() at the effect run. */
	readonly t: number
	/** Which probe fired: 'count' | 'route' | 'action-sync'. */
	readonly probe: string
	readonly value: unknown
}

export interface FetchLogEntry {
	readonly t: number
	readonly epoch: number
	readonly route: string
	readonly event: 'create' | 'settle'
	/** Whether the resource's thrown payload is a foreign (non-Promise) thenable. */
	readonly foreign: boolean
}

export interface LatticeVerdict {
	readonly t: number
	/** Every reader's committed text in the disagreeing frame, main mirror last. */
	readonly values: readonly string[]
}

export interface MountProbeEntry {
	readonly t: number
	readonly count: number
	readonly doubled: number
	readonly view: string
	/** count*2 === doubled within this committed frame. */
	readonly consistent: boolean
}

export interface PairVerdict {
	readonly t: number
	readonly a: number
	readonly b: number
}

export interface MirrorFrame {
	readonly t: number
	readonly signal: number
	readonly state: number
	readonly other: number
}

export interface ScopeProbeResult {
	/** Read taken inside the transition scope, after its write. */
	readonly inScope: unknown
	/** Read taken right after the scope returned, before any commit. */
	readonly ambient: unknown
}

export interface HoldHandle {
	readonly epoch: number
	/** Reads taken inside the transition scope after its writes. */
	readonly scopeReads: Record<string, unknown>
}

export interface TestStore {
	readonly name: string
	readonly holdStyle: TransitionHoldStyle

	/** Outside-render read of a labeled signal (foreign call stack — the RT4 posture). */
	read(label: string): unknown
	/** Urgent set() on a labeled atom. */
	write(label: string, value: unknown): void
	/** set() inside startSignalTransition. */
	transitionWrite(label: string, value: unknown): void
	/** Several set()s inside ONE startSignalTransition scope (AT1's batch shape). */
	transitionWriteMany(writes: Record<string, unknown>): void
	/** Pure-updater increment, urgent or transition-wrapped. */
	increment(label: string, mode: 'urgent' | 'transition'): void
	/** Write inside a transition scope, reading back in-scope and ambient (RT1/RT4 probe). */
	transitionScopeProbe(label: string, value: unknown): ScopeProbeResult

	/** Held transition applying `writes` (label → value) plus the gate-A suspension. */
	holdTransition(writes: Record<string, unknown>): HoldHandle
	releaseHold(): void
	/** Independent second gate, for interleaved-holds scenarios. */
	holdTransitionB(writes: Record<string, unknown>): HoldHandle
	releaseHoldB(): void

	/** Async action: sync prefix (action-sync +1) held open on the action gate. */
	beginAsyncAction(): void
	/**
	 * Settle the action's await. The continuation then issues a bare write
	 * (action-post +1: ambient/urgent per AT2/WP4) and a re-wrapped write
	 * (action-rejoin +1 inside startSignalTransition: AT3's rejoin probe).
	 */
	settleAsyncAction(): void
	/** Release the action gate so the sync prefix (and a rejoined write) can commit. */
	releaseAsyncAction(): void

	/** Resources and gates created from now on throw foreign (non-Promise) thenables. */
	setForeignThenable(enabled: boolean): void
	/** Per-reader synchronous render cost for the lattice, in milliseconds. */
	setLatticeWork(ms: number): void

	startAutoIncrement(everyMs: number, mode: 'urgent' | 'transition'): void
	stopAutoIncrement(): void

	/** Second React root over the same atoms (WP1 shape). */
	mountSecondRoot(): void
	unmountSecondRoot(): void

	/** Urgent-lane React.use probe (FIND-URGENT-USE). */
	armUseProbe(): void
	settleUseProbe(): void

	readonly effectLog: readonly EffectLogEntry[]
	readonly fetchLog: readonly FetchLogEntry[]
	/**
	 * Two tear latches with different strictness:
	 * - `torn` (layout effect): sees the committed DOM before paint — the
	 *   strict RCC-RT5 instrument; catches frames a same-task corrective
	 *   pass would repair before the user sees them.
	 * - `tornPassive` (passive effect): daishi's original mechanism — the
	 *   frame survived to the passive flush, so a user could see it.
	 */
	readonly lattice: {
		checks: number
		torn: LatticeVerdict[]
		passiveChecks: number
		tornPassive: LatticeVerdict[]
	}
	readonly pairTorn: readonly PairVerdict[]
	readonly mirrorFrames: readonly MirrorFrame[]
	readonly mountProbeLog: readonly MountProbeEntry[]
	/** Render-invocation tallies per probe name (includes speculative passes). */
	readonly renderCounts: Readonly<Record<string, number>>
}

declare global {
	interface Window {
		__store: TestStore
	}
}

// ---- the label registry ----------------------------------------------------------------

const registry = new Map<string, ReadableSignal<unknown>>()

function registerSignals(handles: Record<string, ReadableSignal<unknown>>): void {
	for (const [label, signal] of Object.entries(handles)) {
		if (registry.has(label)) {
			throw new Error(`testkit: duplicate signal label "${label}"`)
		}
		registry.set(label, signal)
	}
}

function signalOf(label: string): ReadableSignal<unknown> {
	const signal = registry.get(label)
	if (signal === undefined) {
		throw new Error(`testkit: no signal labeled "${label}"`)
	}
	return signal
}

function atomOf(label: string): WritableSignal<unknown> {
	const signal = signalOf(label) as Partial<WritableSignal<unknown>>
	if (typeof signal.set !== 'function') {
		throw new Error(`testkit: signal "${label}" is not writable`)
	}
	return signal as WritableSignal<unknown>
}

/** App.tsx hands its module-level atoms over at module init. */
export function registerAppHandles(handles: Record<string, ReadableSignal<unknown>>): void {
	registerSignals(handles)
}

// ---- logs ------------------------------------------------------------------------------

const effectLog: EffectLogEntry[] = []
const fetchLog: FetchLogEntry[] = []
const lattice: {
	checks: number
	torn: LatticeVerdict[]
	passiveChecks: number
	tornPassive: LatticeVerdict[]
} = { checks: 0, torn: [], passiveChecks: 0, tornPassive: [] }
const pairTorn: PairVerdict[] = []
const mirrorFrames: MirrorFrame[] = []
const mountProbeLog: MountProbeEntry[] = []
const renderCounts: Record<string, number> = {}

function countRender(probe: string): number {
	renderCounts[probe] = (renderCounts[probe] ?? 0) + 1
	return renderCounts[probe]
}

// The effect-timing DOM log: entries append imperatively so the log itself
// never re-renders the tree whose effects it observes.
let effectLogEl: HTMLOListElement | null = null

function pushEffect(probe: string, value: unknown): void {
	const entry: EffectLogEntry = { t: performance.now(), probe, value }
	effectLog.push(entry)
	if (effectLogEl !== null) {
		const li = document.createElement('li')
		li.textContent = `${Math.round(entry.t)} ${probe}=${String(value)}`
		effectLogEl.append(li)
		while (effectLogEl.childElementCount > 50) {
			effectLogEl.firstElementChild?.remove()
		}
	}
}

// ---- foreign thenables -------------------------------------------------------------------

let foreignThenables = false

/**
 * The battery's foreign-thenable mode: the thrown payload is a bare object
 * with a then method — thenable-shaped but not a Promise instance — which is
 * exactly what a userland cache or a non-native promise library hands React.
 */
export function maybeWrapThenable<T>(promise: Promise<T>): PromiseLike<T> {
	if (!foreignThenables) {
		return promise
	}
	return {
		then(onFulfilled, onRejected) {
			void promise.then(onFulfilled, onRejected)
			return undefined as unknown as PromiseLike<never>
		},
	}
}

/** App.tsx reports each navigation resource's lifecycle here (fetch counters). */
export function recordFetch(epoch: number, route: string, event: 'create' | 'settle'): void {
	if (!TEST_MODE) {
		return
	}
	fetchLog.push({ t: performance.now(), epoch, route, event, foreign: foreignThenables })
}

// ---- testkit atoms ------------------------------------------------------------------------
// Created unconditionally (atom creation is cheap and engine-safe at module
// init); every consumer below is only rendered/installed in test mode.

const storeOnly = createAtom(0, 'tkStoreOnly') // no component ever subscribes (CR3)
const gateA = createAtom(0, 'tkGateA')
const gateB = createAtom(0, 'tkGateB')
const gateAction = createAtom(0, 'tkGateAction')
const pairA = createAtom(0, 'tkPairA')
const pairB = createAtom(0, 'tkPairB')
const mirrorSig = createAtom(0, 'tkMirrorSig')
const actionSync = createAtom(0, 'tkActionSync')
const actionPost = createAtom(0, 'tkActionPost')
const actionRejoin = createAtom(0, 'tkActionRejoin')
const useProbeEpoch = createAtom(0, 'tkUseProbeEpoch')
const latticeMode = createAtom<'off' | 'plain' | 'deferred'>('off', 'tkLatticeMode')
const renderWriteVictim = createAtom(0, 'tkRenderWriteVictim')

registerSignals({
	storeOnly,
	pairA,
	pairB,
	mirrorSig,
	actionSync,
	actionPost,
	actionRejoin,
	latticeMode,
	renderWriteVictim,
})

// ---- hold gates -----------------------------------------------------------------------------
// A held transition: the scope writes its atoms and bumps the gate atom; the
// gate component (subscribed to the gate atom) sees the new epoch only in
// the transition's render and throws the gate's payload — so the transition
// stays pending until release, exactly like the app's navigation hold.

interface Gate {
	epoch: number
	status: 'idle' | 'pending'
	payload: PromiseLike<void> | null
	settle: (() => void) | null
}

function createGate(): Gate {
	return { epoch: 0, status: 'idle', payload: null, settle: null }
}

const gates = { a: createGate(), b: createGate(), action: createGate() }

function openGate(gate: Gate): void {
	gate.epoch += 1
	gate.status = 'pending'
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	// The payload is created once per hold: re-renders re-throw the same
	// reference (SU1's stability rule holds even for the harness itself).
	gate.payload = maybeWrapThenable(promise)
	gate.settle = () => {
		gate.status = 'idle'
		resolve()
	}
}

function releaseGate(gate: Gate): void {
	gate.settle?.()
	gate.settle = null
}

function holdWith(
	gate: Gate,
	gateAtom: WritableSignal<number>,
	writes: Record<string, unknown>,
): HoldHandle {
	openGate(gate)
	const scopeReads: Record<string, unknown> = {}
	startSignalTransition(() => {
		for (const [label, value] of Object.entries(writes)) {
			atomOf(label).set(value)
		}
		gateAtom.set(gate.epoch)
		for (const label of Object.keys(writes)) {
			scopeReads[label] = signalOf(label).state
		}
	})
	return { epoch: gate.epoch, scopeReads }
}

function GateView(props: {
	gate: Gate
	atom: ReadableSignal<number>
	id: string
}): React.ReactElement {
	const epoch = useSignal(props.atom)
	if (epoch > 0 && props.gate.status === 'pending' && epoch === props.gate.epoch) {
		// Suspend this render on the hold: inside a transition render this
		// keeps the transition open; on a cold mount it shows the gate's own
		// fallback below, never the app's.
		throw props.gate.payload
	}
	return <span data-testid={`gate-${props.id}`} data-epoch={epoch} />
}

// ---- async action harness ------------------------------------------------------------------

let actionAwait: { promise: Promise<void>; resolve: () => void } | null = null

function beginAsyncAction(): void {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	actionAwait = { promise, resolve }
	// The sync prefix: joins the action's transition batch (AT1) and is held
	// open by the action gate so its pending-ness stays observable (AT4).
	openGate(gates.action)
	startSignalTransition(() => {
		actionSync.update((n) => n + 1)
		gateAction.set(gates.action.epoch)
	})
	// The continuation lives on a promise-continuation call stack — AT2's
	// exact shape. The bare write must land ambient/urgent; the re-wrapped
	// write probes AT3 (does it rejoin the pending batch or commit alone?).
	void (async () => {
		await promise
		actionPost.update((n) => n + 1)
		startSignalTransition(() => {
			actionRejoin.update((n) => n + 1)
		})
	})()
}

// ---- auto increment ---------------------------------------------------------------------------

let autoIncrementTimer: number | null = null

function startAutoIncrement(everyMs: number, mode: 'urgent' | 'transition'): void {
	stopAutoIncrement()
	const tick = (): void => {
		const bump = (): void => atomOf('count').update((n) => (n as number) + 1)
		if (mode === 'transition') {
			startSignalTransition(bump)
		} else {
			bump()
		}
	}
	autoIncrementTimer = window.setInterval(tick, everyMs)
}

function stopAutoIncrement(): void {
	if (autoIncrementTimer !== null) {
		window.clearInterval(autoIncrementTimer)
		autoIncrementTimer = null
	}
}

// ---- lattice (daishi port) --------------------------------------------------------------------

export const LATTICE_SIZE = 20

// A plain module number, not an atom: the knob is mechanism configuration,
// and an atom here would make every reader re-render (at the new, heavier
// cost) the moment the knob moves.
let latticeWorkMs = 0

function syncWork(): void {
	if (latticeWorkMs <= 0) {
		return
	}
	const start = performance.now()
	while (performance.now() - start < latticeWorkMs) {
		// busy loop — daishi's syncBlock: deliberate synchronous render cost
	}
}

function LatticeReader(props: { index: number }): React.ReactElement {
	const value = useSignal(atomOf('count') as ReadableSignal<number>)
	syncWork()
	const renders = countRender(`lattice-${props.index}`)
	return (
		<span className="lat" data-lat={String(value)} data-render-count={renders}>
			{value}
		</span>
	)
}

function DeferredLatticeReader(props: { index: number }): React.ReactElement {
	const live = useSignal(atomOf('count') as ReadableSignal<number>)
	const value = React.useDeferredValue(live)
	syncWork()
	const renders = countRender(`lattice-${props.index}`)
	return (
		<span className="lat" data-lat={String(value)} data-render-count={renders}>
			{value}
		</span>
	)
}

function Lattice(): React.ReactElement | null {
	const mode = useSignal(latticeMode)
	const main = useSignal(atomOf('count') as ReadableSignal<number>)
	const containerRef = React.useRef<HTMLDivElement | null>(null)

	// The per-commit equality latches — effects only, so discarded
	// speculative passes never count as torn. Deferred readers lag by design
	// (useDeferredValue), so latches only compare reader-vs-reader within
	// one mode, mirroring daishi's same-hook-everywhere grids.
	const readLatticeDom = React.useCallback((): string[] | null => {
		const container = containerRef.current
		if (container === null) {
			return null
		}
		const values = [...container.querySelectorAll('[data-lat]')].map(
			(el) => el.getAttribute('data-lat') ?? '',
		)
		return mode === 'plain' ? [...values, String(main)] : values
	}, [mode, main])
	// Strict latch: layout effect — the committed DOM before paint.
	React.useLayoutEffect(() => {
		if (mode === 'off') {
			return
		}
		const all = readLatticeDom()
		if (all === null) {
			return
		}
		lattice.checks += 1
		if (all.length > 1 && !all.every((v) => v === all[0])) {
			lattice.torn.push({ t: performance.now(), values: all })
		}
	})
	// daishi-faithful latch: passive effect — the frame survived to the
	// passive flush (daishi's useCheckTearing ran here).
	React.useEffect(() => {
		if (mode === 'off') {
			return
		}
		const all = readLatticeDom()
		if (all === null) {
			return
		}
		lattice.passiveChecks += 1
		if (all.length > 1 && !all.every((v) => v === all[0])) {
			lattice.tornPassive.push({ t: performance.now(), values: all })
		}
	})

	if (mode === 'off') {
		return null
	}
	const Reader = mode === 'plain' ? LatticeReader : DeferredLatticeReader
	return (
		<div ref={containerRef} data-testid="lattice" data-mode={mode}>
			<output data-testid="lattice-main">{main}</output>
			<div className="latgrid">
				{Array.from({ length: LATTICE_SIZE }, (_, index) => (
					<Reader key={index} index={index} />
				))}
			</div>
		</div>
	)
}

// ---- probes ------------------------------------------------------------------------------------

function MountProbe(): React.ReactElement {
	const value = useSignal(atomOf('count') as ReadableSignal<number>)
	const twice = useSignal(signalOf('doubled') as ReadableSignal<number>)
	const view = useSignal(signalOf('currentRoute') as ReadableSignal<string>)
	const renders = countRender('mount-probe')
	React.useLayoutEffect(() => {
		mountProbeLog.push({
			t: performance.now(),
			count: value,
			doubled: twice,
			view,
			consistent: twice === value * 2,
		})
	})
	return (
		<span
			data-testid="mount-probe"
			data-count={value}
			data-doubled={twice}
			data-render-count={renders}
		/>
	)
}

/** Two atoms always written together: any committed frame where they differ is a tear (AT1). */
function PairProbe(): React.ReactElement {
	const a = useSignal(pairA)
	const b = useSignal(pairB)
	React.useLayoutEffect(() => {
		if (a !== b) {
			pairTorn.push({ t: performance.now(), a, b })
		}
	})
	return (
		<span data-testid="pair" data-a={a} data-b={b}>
			{a}:{b}
		</span>
	)
}

/** The same atom read through two independent hooks; frames must agree (R5 / RT5.double-read). */
function DoubleReadProbe(): React.ReactElement {
	const first = useSignal(atomOf('count') as ReadableSignal<number>)
	const second = useSignal(atomOf('count') as ReadableSignal<number>)
	return (
		<span data-testid="double-read" data-agree={first === second ? 'yes' : 'no'}>
			{first}/{second}
		</span>
	)
}

function EffectProbes(): null {
	useSignalEffect(() => {
		pushEffect('count', (signalOf('count') as ReadableSignal<number>).state)
	}, [])
	useSignalEffect(() => {
		pushEffect('route', (signalOf('currentRoute') as ReadableSignal<string>).state)
	}, [])
	useSignalEffect(() => {
		pushEffect('action-sync', actionSync.state)
	}, [])
	return null
}

/** Signal + useState mirror written in the same handler must agree in every frame (SP3 parity). */
function MirrorProbe(): React.ReactElement {
	const signal = useSignal(mirrorSig)
	const [state, setState] = React.useState(0)
	const [other, setOther] = React.useState(0)
	React.useLayoutEffect(() => {
		mirrorFrames.push({ t: performance.now(), signal, state, other })
	})
	return (
		<span>
			<button
				type="button"
				data-testid="mirror-write"
				onClick={() => {
					mirrorSig.update((n) => n + 1)
					setState((n) => n + 1)
					flushSync(() => setOther((n) => n + 1))
				}}
			>
				mirror write + flushSync
			</button>
			<span data-testid="mirror">
				{signal}:{state}:{other}
			</span>
		</span>
	)
}

/** Renders a forbidden render-phase write when mounted; the boundary reports the outcome (UM2). */
function RenderWriteProbe(): React.ReactElement {
	// Deliberate contract violation: a render-phase write to shared state.
	renderWriteVictim.set(1)
	return <span data-testid="render-write-outcome">wrote-without-error</span>
}

interface BoundaryState {
	message: string | null
}

class ProbeBoundary extends React.Component<React.PropsWithChildren, BoundaryState> {
	override state: BoundaryState = { message: null }
	static getDerivedStateFromError(error: unknown): BoundaryState {
		return { message: String(error) }
	}
	override render(): React.ReactNode {
		if (this.state.message !== null) {
			return <span data-testid="render-write-outcome">rejected: {this.state.message}</span>
		}
		return this.props.children
	}
}

// ---- urgent React.use probe --------------------------------------------------------------------

let useProbePromise: { promise: Promise<string>; resolve: (v: string) => void } | null = null

function UseProbe(): React.ReactElement {
	const epoch = useSignal(useProbeEpoch)
	if (epoch === 0 || useProbePromise === null) {
		return <span data-testid="use-probe">idle</span>
	}
	const value = React.use(useProbePromise.promise)
	return <span data-testid="use-probe">{value}</span>
}

// ---- second root -------------------------------------------------------------------------------

function SecondRootMirror(): React.ReactElement {
	const value = useSignal(atomOf('count') as ReadableSignal<number>)
	const renders = countRender('second-root')
	return (
		<output data-testid="second-root-count" data-render-count={renders}>
			{value}
		</output>
	)
}

let secondRoot: { root: Root; el: HTMLElement } | null = null

function mountSecondRoot(): void {
	if (secondRoot !== null) {
		return
	}
	const el = document.createElement('div')
	el.id = 'second-root'
	document.body.append(el)
	const root = createRoot(el)
	root.render(<SecondRootMirror />)
	secondRoot = { root, el }
}

function unmountSecondRoot(): void {
	if (secondRoot === null) {
		return
	}
	secondRoot.root.unmount()
	secondRoot.el.remove()
	secondRoot = null
}

// ---- the store -----------------------------------------------------------------------------------

function installStore(): void {
	const store: TestStore = {
		name,
		holdStyle: transitionHoldStyle,

		read: (label) => signalOf(label).state,
		write: (label, value) => atomOf(label).set(value),
		transitionWrite: (label, value) => {
			startSignalTransition(() => atomOf(label).set(value))
		},
		transitionWriteMany: (writes) => {
			startSignalTransition(() => {
				for (const [label, value] of Object.entries(writes)) {
					atomOf(label).set(value)
				}
			})
		},
		increment: (label, mode) => {
			const bump = (): void => atomOf(label).update((n) => (n as number) + 1)
			if (mode === 'transition') {
				startSignalTransition(bump)
			} else {
				bump()
			}
		},
		transitionScopeProbe: (label, value) => {
			let inScope: unknown
			startSignalTransition(() => {
				atomOf(label).set(value)
				inScope = signalOf(label).state
			})
			// The scope has returned; nothing has committed yet (transitions
			// render asynchronously), so this is the ambient pre-commit read.
			const ambient = signalOf(label).state
			return { inScope, ambient }
		},

		holdTransition: (writes) => holdWith(gates.a, gateA, writes),
		releaseHold: () => releaseGate(gates.a),
		holdTransitionB: (writes) => holdWith(gates.b, gateB, writes),
		releaseHoldB: () => releaseGate(gates.b),

		beginAsyncAction,
		settleAsyncAction: () => actionAwait?.resolve(),
		releaseAsyncAction: () => releaseGate(gates.action),

		setForeignThenable: (enabled) => {
			foreignThenables = enabled
		},
		setLatticeWork: (ms) => {
			latticeWorkMs = ms
		},

		startAutoIncrement,
		stopAutoIncrement,

		mountSecondRoot,
		unmountSecondRoot,

		armUseProbe: () => {
			let resolve!: (v: string) => void
			const promise = new Promise<string>((r) => {
				resolve = r
			})
			useProbePromise = { promise, resolve }
			useProbeEpoch.update((n) => n + 1) // urgent write: the suspension lands on the urgent lane
		},
		settleUseProbe: () => useProbePromise?.resolve('settled'),

		effectLog,
		fetchLog,
		lattice,
		pairTorn,
		mirrorFrames,
		mountProbeLog,
		renderCounts,
	}
	window.__store = store
}

if (TEST_MODE) {
	installStore()
}

// ---- the panel -------------------------------------------------------------------------------------

/** Rendered by App only when TEST_MODE; all hooks below assume that gate. */
export function TestPanel(): React.ReactElement {
	const [showMountProbe, setShowMountProbe] = React.useState(false)
	const [showRenderWrite, setShowRenderWrite] = React.useState(false)
	const actionSyncValue = useSignal(actionSync)
	const actionPostValue = useSignal(actionPost)
	const actionRejoinValue = useSignal(actionRejoin)

	return (
		<section id="testpanel" aria-label="battery instrumentation">
			<div className="actions">
				<button
					type="button"
					data-testid="mount-probe-toggle"
					aria-pressed={showMountProbe}
					onClick={() => setShowMountProbe((on) => !on)}
				>
					mount probe
				</button>
				<button
					type="button"
					data-testid="render-write-toggle"
					aria-pressed={showRenderWrite}
					onClick={() => setShowRenderWrite((on) => !on)}
				>
					render-write probe
				</button>
				<button
					type="button"
					data-testid="flushsync-increment"
					onClick={() => flushSync(() => atomOf('count').update((n) => (n as number) + 1))}
				>
					flushSync +1
				</button>
				<button
					type="button"
					data-testid="increment-one-transition"
					onClick={() =>
						startSignalTransition(() => atomOf('count').update((n) => (n as number) + 1))
					}
				>
					+1 transition
				</button>
				<button
					type="button"
					data-testid="double-urgent"
					onClick={() => atomOf('count').update((n) => (n as number) * 2)}
				>
					×2 urgent
				</button>
				<button
					type="button"
					data-testid="lattice-show-plain"
					onClick={() => startSignalTransition(() => latticeMode.set('plain'))}
				>
					lattice plain
				</button>
				<button
					type="button"
					data-testid="lattice-show-deferred"
					onClick={() => startSignalTransition(() => latticeMode.set('deferred'))}
				>
					lattice deferred
				</button>
				<button
					type="button"
					data-testid="lattice-hide"
					onClick={() => startSignalTransition(() => latticeMode.set('off'))}
				>
					lattice off
				</button>
			</div>

			<div className="cells">
				<output data-testid="action-sync">{actionSyncValue}</output>
				<output data-testid="action-post">{actionPostValue}</output>
				<output data-testid="action-rejoin">{actionRejoinValue}</output>
				<PairProbe />
				<DoubleReadProbe />
				<MirrorProbe />
				{showMountProbe ? <MountProbe /> : null}
			</div>

			{showRenderWrite ? (
				<ProbeBoundary>
					<RenderWriteProbe />
				</ProbeBoundary>
			) : null}

			<React.Suspense fallback={<span data-testid="gate-a-fallback">gate-a pending</span>}>
				<GateView gate={gates.a} atom={gateA} id="a" />
			</React.Suspense>
			<React.Suspense fallback={<span data-testid="gate-b-fallback">gate-b pending</span>}>
				<GateView gate={gates.b} atom={gateB} id="b" />
			</React.Suspense>
			<React.Suspense
				fallback={<span data-testid="gate-action-fallback">gate-action pending</span>}
			>
				<GateView gate={gates.action} atom={gateAction} id="action" />
			</React.Suspense>
			<React.Suspense fallback={<span data-testid="use-probe-fallback">use pending</span>}>
				<UseProbe />
			</React.Suspense>

			<Lattice />
			<EffectProbes />
			<ol
				data-testid="effect-log"
				ref={(el) => {
					effectLogEl = el
				}}
			/>
		</section>
	)
}
