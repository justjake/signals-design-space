/**
 * Connects raw React scheduling facts to one cosignals engine. React owns
 * lanes and root render/commit timing; ReactBatchRegistry turns those facts
 * into stable batch identities; the engine owns worlds and subscriptions.
 *
 * Registry and engine identities are deliberately separate. The two bounded
 * maps below translate while a batch is live because the engine can also
 * create ambient batches. Render events select an engine world, writes read
 * the current registry batch, and deliveries schedule back into its live
 * React lane. Suspense evaluation remains entirely engine-owned.
 */

import * as React from 'react'
import { ReactBatchRegistry } from 'react-signals-utils'
import {
	BATCH_NONE,
	Computed,
	ReducerAtom,
	SuspendedRead,
	attachDriver,
	engine,
	type ComputedCtx,
} from 'cosignals'
import type {
	AnyInternals,
	Atom,
	AtomInternals,
	Cosignals,
	CosignalEngine,
	EngineDriver,
	RenderPass,
	RootId,
	BatchId,
	Value,
	Watcher,
} from 'cosignals'

// ---- fork detection --------------------------------------------------------------

/** Rejects React builds without the private signals taps. */
export function assertForkPresent(): void {
	const channel = (
		React as unknown as {
			__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
				E?: { forkProtocolVersion?: unknown } | null
			}
		}
	).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.E
	if (channel?.forkProtocolVersion !== 1) {
		throw new Error(
			'cosignals-react requires the patched React signals protocol; stock React is unsupported.',
		)
	}
}

// ---- shim types ------------------------------------------------------------------

/**
 * A live delivery target: the shim-side handle for one watcher (the
 * engine's record of one subscribed component instance) that can re-render
 * the owning component.
 */
export type WatcherTarget = {
	/** Schedules a re-render of the owning component (a setState bump). */
	bump: () => void
	live: boolean
}

type RootRec = {
	id: RootId
	/** The open engine render mirroring the protocol host's in-progress render, if any. */
	renderPass: RenderPass | undefined
	/** Watcher ids created during the current/most recent render, for the orphan sweep. */
	created: Set<number>
}

/**
 * Fallback root id for effects/watchers created outside any tracked
 * render (defensive paths; both packages name it through this one
 * constant).
 */
export const ROOT_UNKNOWN: RootId = 'root-unknown'

let nextRootSerial = 1

/** The one active shim (module registry; hooks.ts manages activation). */
let activeShim: Shim | undefined

export function setActiveShim(shim: Shim): void {
	activeShim = shim
}

/**
 * Clears the active-shim slot only if it still points at `shim` — a
 * disposed predecessor's late unregister must never clobber a successor's
 * registration.
 */
export function unregisterShim(shim: Shim): void {
	if (activeShim === shim) {
		activeShim = undefined
	}
}

/**
 * The active shim if it is still live. (A shim disposed directly — without
 * its handle's dispose, which unregisters it — can linger in the slot; the
 * liveness filter keeps it from being served or from blocking re-registration.)
 */
export function getActiveShim(): Shim | undefined {
	return activeShim !== undefined && !activeShim.disposed ? activeShim : undefined
}

// ---- the shim --------------------------------------------------------------------

export class Shim {
	/**
	 * The engine surface this shim is bound to — the default browser instance,
	 * or the per-request instance passed to registerCosignalReact() for
	 * synchronous SSR. The field keeps the bindings' historical name to spare
	 * every call site.
	 */
	readonly bridge: CosignalEngine
	/**
	 * The bound instance's public Computed/ReducerAtom classes (the default
	 * instance's when none was passed). The creating hooks (useComputed,
	 * useReducerAtom) create handles from THESE so a per-instance-bound shim never
	 * produces a handle owned by a different engine than it routes through.
	 */
	readonly Computed: typeof Computed
	readonly ReducerAtom: typeof ReducerAtom
	/** Enables unreachable-state checks and the post-await write warning. */
	readonly devChecks: boolean
	disposed = false
	/** Listener/translation errors (recorded, not thrown across React's commit). */
	errors: unknown[] = []
	/** Dev warnings surfaced (shim-local heuristics; console-warned once per message). */
	devWarnings: string[] = []
	private warned = new Set<string>()

	private readonly registry: ReactBatchRegistry
	private readonly registryToEngine = new Map<number, BatchId>()
	private readonly engineToRegistry = new Map<BatchId, number>()
	private unsubscribe: () => void
	private rootsByContainer = new Map<unknown, RootRec>()
	/** watcher id -> delivery target (registered at render, claimed at layout). */
	targets = new Map<number, WatcherTarget>()
	/** watcher id -> claimed by a committed layout effect (StrictMode orphan sweep). */
	claimed = new Set<number>()
	/** SignalEffect id -> its hook-owned stable cleanup/body runner. */
	private effectRunners = new Map<number, () => void>()
	constructor(instance?: Cosignals) {
		this.bridge = instance?.engine ?? engine
		this.Computed = instance?.Computed ?? Computed
		this.ReducerAtom = instance?.ReducerAtom ?? ReducerAtom
		this.devChecks = this.bridge.devChecks
		assertForkPresent()
		this.registry = new ReactBatchRegistry(React)
		// Install the engine driver before subscribing to React so a duplicate
		// attachment cannot leave a registry subscription behind.
		const driver: EngineDriver = {
			// The write context — the one foreign call the engine makes per
			// classified public write (dispatch is engine-internal after it).
			currentBatch: () => this.currentBatch(),
			// The ambient-world provider answers from the live call context, per
			// read: a render resolves its own render's world via the protocol's
			// render context (stack-accurate — a COMPLETED-but-uncommitted render
			// is not "in render", and interleaved roots each see their own
			// render); anything else resolves newest (undefined). Effect fires
			// need no arm here: the engine's SignalEffect frame owns
			// committed-for-root routing and dependency capture (the promoted
			// mechanism), and the engine consults its own frame before this
			// provider.
			worldFor: () => {
				const rendering = this.renderingRoot()
				if (rendering?.renderPass !== undefined && rendering.renderPass.state !== 'ended') {
					return { kind: 'render', render: rendering.renderPass }
				}
				return undefined
			},
			// Direct listeners — the load-bearing consumption surface. The
			// engine's trace stream stays a test/tracing artifact (it does not
			// create unless a test retains it or a tracer attaches);
			// scheduling decisions arrive here as live objects, allocation-free.
			// Listener bodies must never throw into the engine mid-operation:
			// failures are recorded. One listener error policy: guard() — which
			// also closes the disposed window (the driver record outlives the
			// shim, so post-dispose engine callbacks must be no-ops rather than
			// relying on the cleared `targets` map to degrade safely).
			onDelivery: (w, batch) => this.guard(() => this.bumpInBatch(w.id, batch.id)), // re-render in the write's own batch
			onMountCorrective: (w, batch) => this.guard(() => this.bumpInBatch(w.id, batch.id)), // join a still-live batch this mount's render missed
			onCorrection: (w) => this.guard(() => this.bumpInBatch(w.id, undefined)), // urgent pre-paint fix: discrete-urgent fallback lane
			onSignalEffect: (effect) => this.guard(() => this.effectRunners.get(effect.id)?.()),
			// Test-only: the engine reset invokes this first, before scrubbing
			// engine state, so React's batch registry drops its slot tenancy
			// while the engine composition those ids point into still exists.
			protocolReset: () => {
				this.registry.reset()
				this.registryToEngine.clear()
				this.engineToRegistry.clear()
			},
		}
		try {
			;(instance?.attachDriver ?? attachDriver)(driver)
		} catch (error) {
			this.registry.dispose()
			throw error
		}
		this.unsubscribe = this.registry.subscribe({
			onBatchOpened: (registryBatch) =>
				this.guard(() => {
					const batch = this.bridge.openBatch({ deferred: (registryBatch & 1) !== 0 })
					this.registryToEngine.set(registryBatch, batch.id)
					this.engineToRegistry.set(batch.id, registryBatch)
				}),
			onRenderPassStart: (container, includedBatches) =>
				this.guard(() => this.handleRenderStart(container, includedBatches)),
			onRenderPassYield: (container) => this.guard(() => this.handleYield(container)),
			onRenderPassResume: (container) => this.guard(() => this.handleResume(container)),
			onRenderPassEnd: (container, committed) =>
				this.guard(() => this.handleRenderEnd(container, committed)),
			onBatchRetired: (registryBatch, committed) =>
				this.guard(() => this.handleBatchRetired(registryBatch, committed)),
			onRootCommitted: (container, committedBatches) =>
				this.guard(() => this.handleRootCommitted(container, committedBatches)),
		})
	}

	/** Releases the registry subscription and all shim-owned references. */
	dispose(): void {
		this.disposed = true
		this.unsubscribe()
		this.registry.dispose()
		this.registryToEngine.clear()
		this.engineToRegistry.clear()
		this.targets.clear()
		this.effectRunners.clear()
	}

	/** Listener bodies never throw across React's commit; failures are recorded. */
	private guard(fn: () => void): void {
		if (this.disposed) {
			return
		}
		try {
			fn()
		} catch (error) {
			this.errors.push(error)
		}
	}

	/** Errors recorded since the last call (tests assert this stays empty). */
	takeErrors(): unknown[] {
		const out = this.errors
		this.errors = []
		return out
	}

	private devWarn(message: string): void {
		this.devWarnings.push(message)
		if (!this.warned.has(message)) {
			this.warned.add(message)
			// eslint-disable-next-line no-console
			console.warn(`cosignals: ${message}`)
		}
	}

	// ---- roots and batches ----------------------------------------------------

	rootRec(container: unknown): RootRec {
		let rec = this.rootsByContainer.get(container)
		if (rec === undefined) {
			rec = {
				id: `root-${nextRootSerial++}`,
				renderPass: undefined,
				created: new Set(),
			}
			this.rootsByContainer.set(container, rec)
			this.bridge.root(rec.id) // materialize the per-root committed table
		}
		return rec
	}

	/** Keeps an existing live engine batch pending until its action settles. */
	upgradeToAction(batchId: BatchId): void {
		const t = this.bridge.idToBatch.get(batchId)
		if (t !== undefined && t.state === 'live') {
			t.action = true
			t.parked = true
		}
	}

	/** The root whose render is currently rendering, if any. The protocol resolves the render context from the current call stack, so this is only meaningful synchronously during a render. */
	renderingRoot(): RootRec | undefined {
		const ctx = this.registry.getRenderContext()
		if (ctx === null) {
			return undefined
		}
		return this.rootsByContainer.get(ctx.container)
	}

	// ---- protocol listener -> bridge --------------------------------------------

	private handleRenderStart(container: unknown, includedBatches: readonly number[]): void {
		const rec = this.rootRec(container)
		if (rec.renderPass !== undefined && rec.renderPass.state !== 'ended') {
			// The protocol host closes a render frame (onRenderPassEnd) before
			// restarting the root, so a still-open render here means the two
			// sides desynced.
			if (this.devChecks) {
				throw new Error(
					`cosignals-react: protocol violation — render pass started on ${rec.id} while its previous render is still open`,
				)
			}
			// Defined fall-through: discard the stale render. A discarded render
			// contributes nothing to committed truth (its batch set never locks
			// into the root's committed table; render-owned mounts die), so this
			// cannot double-account — while leaving it open would pin the
			// engine's pending window forever.
			this.bridge.renderEnd(rec.renderPass.id, 'discard')
		}
		const known: BatchId[] = []
		for (const registryBatch of includedBatches) {
			const batchId = this.registryToEngine.get(registryBatch)
			if (batchId !== undefined && this.bridge.idToBatch.get(batchId)?.state === 'live') {
				known.push(batchId)
			}
		}
		rec.renderPass = this.bridge.renderStart(rec.id, known)
		rec.created = new Set()
	}

	private handleYield(container: unknown): void {
		const rec = this.rootsByContainer.get(container)
		if (rec?.renderPass === undefined || rec.renderPass.state === 'ended') {
			return
		}
		this.bridge.renderYield(rec.renderPass.id)
	}

	private handleResume(container: unknown): void {
		const rec = this.rootsByContainer.get(container)
		if (rec?.renderPass === undefined || rec.renderPass.state === 'ended') {
			return
		}
		this.bridge.renderResume(rec.renderPass.id)
	}

	private handleRenderEnd(container: unknown, committed: boolean): void {
		const rec = this.rootsByContainer.get(container)
		if (rec?.renderPass === undefined || rec.renderPass.state === 'ended') {
			return
		}
		const render = rec.renderPass
		if (!committed) {
			// Discard: render-owned mounts die in the bridge; drop their targets too.
			this.bridge.renderEnd(render.id, 'discard')
			for (const wid of rec.created) {
				if (!this.claimed.has(wid)) {
					this.targets.delete(wid)
				}
			}
			rec.created = new Set()
			rec.renderPass = undefined
			return
		}
		// The end(commit) event is where the bridge captures its baseline:
		// bridge.renderEnd snapshots committed state and the root's commit
		// generation on entry — before it locks this render's batches into the
		// root's committed table, and before the protocol's onRootCommitted /
		// onBatchRetired events for the same commit arrive. The mount fixup
		// for watchers created this render runs inside renderEnd; the corrective
		// re-renders it emits reach React through the direct listeners
		// (delivered at the operation boundary, inside this call).
		this.bridge.renderEnd(render.id, 'commit')
		rec.renderPass = undefined
		// (ctx.previous cells update inside bridge.renderEnd — the
		// cells live on the engine's computed nodes, beside their ctx adapter.)
		// Orphan sweep. In development StrictMode React invokes render twice to
		// surface impure renders, so even a committed render can create watchers
		// whose hook instance was thrown away and will never be claimed. Layout
		// effects run synchronously inside the commit, so by the time this
		// microtask runs every claim has happened — any watcher created by this
		// render and still unclaimed is dead.
		const created = rec.created
		rec.created = new Set()
		queueMicrotask(() => {
			if (this.disposed) {
				return
			}
			for (const wid of created) {
				if (this.claimed.has(wid)) {
					continue
				}
				// removeWatcher, never a bare watchers.delete: the engine keeps a
				// per-node watcher index next to the id map, and a map-only delete
				// strands the index entry (dead watchers then seed the engine's
				// sweeps and quiescence refreshes forever).
				this.bridge.removeWatcher(wid)
				this.targets.delete(wid)
			}
		})
	}

	private handleBatchRetired(registryBatch: number, committed: boolean): void {
		const batchId = this.registryToEngine.get(registryBatch)
		if (batchId === undefined) {
			return
		}
		const t = this.bridge.idToBatch.get(batchId)
		if (t === undefined || t.state !== 'live') {
			this.registryToEngine.delete(registryBatch)
			this.engineToRegistry.delete(batchId)
			return
		}
		// The committed/abandoned fact is BORN here — React's own report about
		// its batch. Retirement is disposition-blind (recorded writes never
		// revert either way), so the flag goes no further than this diagnostic
		// record, created straight into the bridge's tracer when one is
		// attached. Batches with no protocol report (the engine-side ambient
		// batch) create none.
		const tr = this.bridge.trace
		if (tr !== undefined) {
			tr.batchDisposition(batchId, committed)
		}
		// Retirement/settlement flush dirty SignalEffect terminals and deliver
		// their runner requests at this operation boundary.
		if (t.parked) {
			this.bridge.settleAction(batchId)
		} // async action reached settlement
		else {
			this.bridge.retire(batchId)
		} // batch done everywhere: its writes become permanent history
		this.registryToEngine.delete(registryBatch)
		this.engineToRegistry.delete(batchId)
	}

	private handleRootCommitted(container: unknown, committedBatches: readonly number[]): void {
		const rec = this.rootRec(container)
		// The bridge already locked the committing render's batch set into the
		// root's committed table at renderEnd(commit). The protocol's per-root
		// commit report is a delta (one batch's work can reach the screen
		// across more than one flush), and re-reporting a batch is defined as
		// idempotent set-add — so hand every reported batch with an engine
		// batch to the engine's commitBatches, THE single owner of the per-root
		// commit transition: already-committed batches skip; a live batch
		// the renderEnd sweep missed locks in COMPLETELY (batch set, committed
		// bit mask, generation, commit clock, arena fan-out, drain — never a
		// partial table write from here). Defensive: for React batches with
		// engine batches the render's set already covers the delta by construction.
		const reported: BatchId[] = []
		for (const registryBatch of committedBatches) {
			const batchId = this.registryToEngine.get(registryBatch)
			if (batchId !== undefined && this.bridge.idToBatch.get(batchId)?.state === 'live') {
				reported.push(batchId)
			}
		}
		if (reported.length !== 0) {
			this.bridge.commitBatches(rec.id, reported)
		}
		// commitBatches is itself a boundary operation: when the report
		// actually moved committed truth, the engine re-checked that root's
		// committed SignalEffects inside the call.
	}

	// ---- direct listeners -> React ---------------------------------------------
	// (Installed through the constructor's driver record: deliveries and mount
	// correctives bump in the causing batch's lane; urgent/reconcile
	// corrections take the discrete-urgent fallback. The engine delivers them
	// at the end of each engine operation.
	// Dev warnings are shim-local and devChecks-gated: the post-await lint
	// lives HERE only, in currentBatch — the engine and the reference model
	// emit no dev events.)

	/** Schedules a re-render in the batch's lane, or urgently if it is gone. */
	private bumpInBatch(watcherId: number, batchId: BatchId | undefined): void {
		const target = this.targets.get(watcherId)
		if (target === undefined || !target.live) {
			return
		}
		const registryBatch =
			batchId === undefined ? BATCH_NONE : (this.engineToRegistry.get(batchId) ?? BATCH_NONE)
		this.registry.runInBatch(registryBatch, () => target.bump())
	}

	// ---- the write context ----------------------------------------------------

	/**
	 * The batch context for the public write executing NOW — the driver's
	 * `currentBatch`, consulted by the engine once per classified write (the
	 * write itself — whole (kind, payload) operations for worlds to replay —
	 * is dispatched engine-internally after this answer). Returns the engine
	 * BatchId, BATCH_NONE included: the engine converges BATCH_NONE to its
	 * ordinary no-context write (quiet fold when nothing is pending, else the
	 * ambient batch) — the same defined fall-through a bare non-React write
	 * takes. Effects stay BOUNDARY consumers of such writes: the engine
	 * validates their dirty graph edges at the next boundary (retirement, settlement,
	 * per-root commit), never mid-write.
	 */
	currentBatch(): BatchId {
		if (this.registry.getRenderContext() !== null) {
			throw new Error(
				'cosignals: signal write during render — write from an event handler or effect instead',
			)
		}
		const registryBatch = this.registry.getCurrentWriteBatch()
		const batchId = this.registryToEngine.get(registryBatch) ?? BATCH_NONE
		// Once the renderer installs its taps, every write context has a
		// registry batch with a close edge. Keep the no-context fall-through
		// for production builds with development checks disabled.
		if (this.devChecks && batchId === BATCH_NONE) {
			throw new Error(
				'cosignals: protocol violation — signal write with no batch context after the renderer installed its signals taps',
			)
		}
		if (this.devChecks) {
			// Dev-warning heuristic. After an await, code runs on a fresh call
			// stack with no ambient transition context, so a bare write lands
			// urgent — while an async action is pending that is usually a bug
			// (the author meant the write to join the action; the fix is a
			// fresh startTransition). Warn on a non-deferred write while any
			// action is parked. Deferredness comes from React when the registry
			// opens the batch; one bit cannot distinguish a discrete handler's
			// batch from a timer's ambient one, so this lint can over-trigger
			// on genuine handler writes during someone else's action —
			// accepted imprecision for a dev-only warning.
			const t = this.bridge.idToBatch.get(batchId)
			let parked = false
			if (t !== undefined && !t.action && !t.deferred) {
				for (const live of this.bridge.liveBatches()) {
					if (live.parked) {
						parked = true
						break
					}
				}
			}
			if (parked) {
				this.devWarn(
					'a signal write after await landed outside the action — wrap it in startTransition',
				)
			}
		}
		return batchId
	}

	// ---- useSignalEffect timing shell -------------------------------------------------
	// The graph terminal, retracking, validation, and liveness live in the engine
	// (mountSignalEffect / captureSignalEffectRun / removeSignalEffect). What stays
	// here is React closure and passive-effect ownership.

	registerEffect(root: RootId, refire: () => void): number {
		this.bridge.root(root) // materialize the per-root committed table (as before)
		const effect = this.bridge.mountSignalEffect(root, `effect@${root}`)
		this.effectRunners.set(effect.id, refire)
		return effect.id
	}

	renderSignalEffect(renderPassId: number, id: number, willRun: boolean): void {
		this.bridge.renderSignalEffect(renderPassId, id, willRun)
	}

	unregisterEffect(id: number): void {
		this.effectRunners.delete(id)
		if (this.bridge.idToSignalEffect.has(id)) {
			this.bridge.removeSignalEffect(id)
		}
	}

	/** Runs an effect body while its committed graph terminal retracks. */
	captureEffectRun(id: number, body: () => void): void {
		if (!this.bridge.idToSignalEffect.has(id)) {
			return
		} // torn down between queue and run
		this.bridge.captureSignalEffectRun(id, body)
	}

	// ---- node resolution --------------------------------------------------------

	/**
	 * The engine internals for a public Atom/ReducerAtom — a delegate to the
	 * engine's own resolution, which allocates content on the atom's first
	 * engine participation (seeding base from kernel-current — the atom's
	 * full committed history — and carrying the handle's own equality).
	 * Kept as a method so the hooks and the suites name one resolution point.
	 */
	internalsForAtom(atom: Atom<unknown>): AtomInternals {
		return this.bridge.internalsForAtom(atom)
	}

	// ---- suspense translation ----------------------------------------------------------
	// (Kernel `Computed` handles are the supported derived type,
	// world-routed through the core's .state read seams, and
	// the engine owns the ctx adapter, the committed previous cells, and the
	// background-suspension fold. What stays here is exactly the React-phase
	// knowledge: hook-initiated evaluations may legally suspend the render.)

	/**
	 * Hook-initiated evaluation — the one "a hook read may legally suspend"
	 * translation (both halves): the bridge counter tells the engine's ctx
	 * adapter and newest read tail to RETHROW a pending suspension instead of
	 * folding it to a sentinel value, and a SuspendedRead carrier unwraps to
	 * its thenable so React suspends the component.
	 */
	hookRead(fn: () => Value): Value {
		this.bridge.suspendDepth++
		try {
			return fn()
		} catch (err) {
			if (err instanceof SuspendedRead) {
				throw err.thenable
			}
			throw err
		} finally {
			this.bridge.suspendDepth--
		}
	}

	/** Register a watcher created during the current render (orphan-sweep set). */
	noteCreated(rootRec: RootRec, watcherId: number): void {
		rootRec.created.add(watcherId)
	}

	// ---- watcher claim / unsubscribe ------------------------------------------------

	/** Layout-effect claim: the committed hook instance owns this watcher. */
	claimWatcher(rec: {
		node: AnyInternals
		watcherId: number | undefined
		target: WatcherTarget
		pendingUnsub: boolean
		root: RootId | undefined
		lastValue: unknown
	}): void {
		rec.pendingUnsub = false
		const w = rec.watcherId === undefined ? undefined : this.bridge.watchers.get(rec.watcherId)
		if (w === undefined) {
			// Reveal without a re-render (React bailed out) or a swept
			// subscription: create a fresh watcher outside any React render and take
			// the conservative reveal path — compare what the committed DOM shows
			// against committed truth, and fix urgently, before paint.
			this.resubscribeAtLayout(rec)
			return
		}
		this.claimed.add(w.id)
		rec.target.live = true
		this.targets.set(w.id, rec.target)
	}

	private resubscribeAtLayout(rec: {
		node: AnyInternals
		watcherId: number | undefined
		target: WatcherTarget
		root: RootId | undefined
		lastValue: unknown
	}): void {
		const root = rec.root ?? ROOT_UNKNOWN
		const render = this.bridge.renderStart(root, [])
		let created: Watcher | undefined
		try {
			created = this.bridge.mountWatcher(render.id, rec.node, 'w?')
			created.name = `w${created.id}`
			this.bridge.deferMountEffects(created.id) // keep it out of the degenerate render
		} finally {
			this.bridge.renderEnd(render.id, 'discard')
		}
		if (created === undefined) {
			return
		}
		created.live = true
		created.lastRenderedValue = rec.lastValue // what the committed DOM shows
		rec.watcherId = created.id
		this.claimed.add(created.id)
		rec.target.live = true
		this.targets.set(created.id, rec.target)
		// Conservative reveal compare: fix any drift urgently, pre-paint.
		const now = this.bridge.committedValue(rec.node, root)
		if (!Object.is(now, rec.lastValue)) {
			this.bumpInBatch(created.id, undefined)
		}
	}

	/** Debounce-finalized unsubscription (or immediate teardown for retired recs). */
	finalizeUnsub(rec: {
		watcherId: number | undefined
		target: WatcherTarget
		pendingUnsub: boolean
	}): void {
		rec.pendingUnsub = false
		rec.target.live = false
		const wid = rec.watcherId
		if (wid === undefined) {
			return
		}
		rec.watcherId = undefined
		this.claimed.delete(wid)
		this.targets.delete(wid)
		// One engine call retires the watcher from every store it lives in
		// (liveness/observation retain, id map, per-node walk index, open
		// mounted lists) — see the engine's removeWatcher.
		this.bridge.removeWatcher(wid)
	}
}

/**
 * The evaluation context bound computed functions receive — the core's
 * ComputedCtx verbatim (`previous` hint + the two-form `ctx.use`), served
 * over the bound node's own state.
 */
export type BoundCtx<T> = ComputedCtx<T>
