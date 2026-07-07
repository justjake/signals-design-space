/**
 * RENDER PASSES and WATCHERS — the render lifecycle of the concurrent
 * engine. A RENDER PASS is one render of one root: its PIN is the timeline
 * position frozen at render start (the render folds nothing written after
 * it, so a paused-and-resumed render never drifts) and its MASK is the set
 * of live batches the render is rendering. A WATCHER is one subscribed
 * component instance (the full vocabulary — write log, batch, slot, world,
 * arena — is defined at the top of concurrent.ts). This module owns:
 *
 *  - the `RenderPass` record and its whole lifecycle: start (pin + mask +
 *    arena claim), yield/resume, and END — the commit fan whose order is
 *    load-bearing (baseline capture → retire-at-commit folds → per-root
 *    lock-in with its drains → layout subscribe + mount fixups → the
 *    re-staled populator loop → deferred releases → arena drop → quiet
 *    recompute → subscription revalidation);
 *  - the `Watcher` record: mount/defer/reveal/re-render/removal, the
 *    rendered-world snapshot, and THE watcher→node resolution
 *    (`resolveWatcherNode`, generation-checked — a dormant watcher whose
 *    node record died must never bind the record's next tenant);
 *  - per-root commit lock-in (`commitBatches`) — THE single owner of a
 *    root's committed-state transition;
 *  - MOUNT FIXUP — the commit-edge reconciliation for freshly mounted
 *    components — with its dependency-closure walks (arena legs through the
 *    core record; the kernel leg walks the kernel's own exported layout).
 *
 * `createRenderPass` is a factory in the kernel's own style: it closes over
 * its state (the render/watcher id counters, the stale-skip diagnostic) and
 * reaches every other mechanism through the shared engine core record's
 * late-bound slots at call time (World evaluation, arena claim/decay/fanout,
 * the deliver walks' drains and corrections, Batch retirement). The
 * pass/watcher REGISTRIES (`idToRenderPass`, `watchers`, `nodeToWatchers`,
 * `rootToOpenRender`) are core-carried shared containers: this module owns
 * every transition; the resident registry's gap-fill, the record-free scrub,
 * and the quiescence sweep read them in place.
 */

import { InvariantViolation, ScheduleError, mustGet } from './errors.js';
import { SuspendedRead, LinkField, NodeField, NodeFlag } from './index.js';
import { E, noteReclaimRetry, reclaimSkippedN } from './graph.js';
import { kernelGenOf, type WorldArena } from './WorldArena.js';
import type { Batch, BatchId, BatchSlot, BatchSlotSet } from './Batch.js';
import type { EngineCore } from './World.js';
import type { AnyNode, CommitGen, NodeId, RenderPassId, RootId, Seq, Value, WatcherId } from './concurrent.js';

/** Dense per-node column key (NodeField.NODE_INDEX — see concurrent.ts). */
type NodeIndex = number;
/** A kernel record's GEN field value: the id-tenancy stamp, bumped at free. */
type Generation = number;

export type RenderPassState = 'open' | 'yielded' | 'ended';

export type RenderPass = {
	id: RenderPassId;
	root: RootId;
	/** The pin — the timeline position frozen at render start; observed for the
	 * render's whole life, across yields, so a paused-and-resumed render never
	 * drifts. */
	pin: Seq;
	maskBatches: Set<BatchId>;
	/** The render's slot sets (bit i = slot i; BatchSlot < 31), fixed at render
	 * start: maskBits — slots of the render mask's written batches;
	 * includedBits — maskBits ∪ the root's committed slots captured at start
	 * (every batch this render is allowed to see). */
	maskBits: BatchSlotSet;
	includedBits: BatchSlotSet;
	state: RenderPassState;
	endKind: 'commit' | 'discard' | undefined;
	/** Watchers whose layout effects (subscribe + fixup) fire at this render's
	 * commit: its own mounts plus adopted reveals. Disjoint from `rendered`. */
	mounted: WatcherId[];
	/** Existing live watchers re-rendered by this render — re-renders ONLY
	 * (disjoint from `mounted`; where render-end means the union it writes the
	 * union explicitly). */
	rendered: Set<WatcherId>;
	/** The render world's arena — its value+invalidation+routing
	 * layer (claimed at renderStart, dropped in reclaimAfterRenderEnd —
	 * engine-side only; the reference model has no counterpart). */
	arena?: WorldArena;
};

/** The watcher's rendered-world snapshot: what the mounting render saw
 * (the render's slot sets copied by integer assignment — see RenderPass). */
export type WatcherSnapshot = {
	renderPassId: RenderPassId;
	pin: Seq;
	maskBits: BatchSlotSet;
	includedBits: BatchSlotSet;
	rootCommitGen: CommitGen;
};

export class Watcher {
	readonly id: WatcherId;
	name: string;
	readonly root: RootId;
	readonly node: NodeId;
	/** The node record's NODE_INDEX, cached at mount (valid exactly while
	 * `nodeRecordGen` still matches the record). @internal */
	readonly nodeIx: NodeIndex;
	/** The node record's tenancy generation (kernel GEN) at mount. Bare ids
	 * alias reused records: kernel record ids recycle through the free list,
	 * so every watcher→node resolution generation-checks this stamp and skips
	 * loudly on mismatch — a dormant watcher whose node died must never bind
	 * the record's next tenant. */
	readonly nodeRecordGen: Generation;
	/** The engine's observed-closure shift (see obsShift): the `live`
	 * setter feeds the watched node's observed-consumer refcount through it
	 * (generation-checked engine-side — a stale watcher's flips shift
	 * nothing), and the observation index propagates retains transitively
	 * over the node's current strong dep set down to lifecycle-carrying
	 * atoms. @internal */
	readonly _observationShift: (w: Watcher, delta: 1 | -1) => void;
	private _live = false;
	lastRenderedValue: Value;
	snapshot: WatcherSnapshot;
	/** Per-(watcher, slot) delivery dedup bits, one int word: a second write
	 * in the same slot delivers again only if no scheduled-but-unstarted
	 * render will fold it anyway. */
	dedupBits: BatchSlotSet = 0;

	constructor(id: WatcherId, name: string, root: RootId, node: NodeId, nodeIx: NodeIndex, nodeRecordGen: Generation, observationShift: (w: Watcher, delta: 1 | -1) => void, value: Value, snapshot: WatcherSnapshot) {
		this.id = id;
		this.name = name;
		this.root = root;
		this.node = node;
		this.nodeIx = nodeIx;
		this.nodeRecordGen = nodeRecordGen;
		this._observationShift = observationShift;
		this.lastRenderedValue = value;
		this.snapshot = snapshot;
	}

	/**
	 * Subscribed-for-delivery bit. The setter is the watcher half of the
	 * observation union (AtomOptions.effect): a live watcher holds one
	 * observed-consumer ref on its node, and the engine's observation
	 * index (obsShift) carries that ref transitively — a watcher over an
	 * atom node retains that atom's lifecycle directly; a watcher over an
	 * engine computed retains every atom the computed's current evaluation
	 * (transitively) reads. EVERY liveness site routes through here — the
	 * commit layout loop and adoptRevealedMount reveals (engine side), and the
	 * reveal resubscribe / StrictMode orphan sweep / debounce-finalized
	 * unsubscribe (the React-bindings side, which flips this field directly)
	 * — so kernel subscribers and watchers count into ONE refcount, and
	 * same-tick flips coalesce in the kernel's microtask flush.
	 * Edge-filtered: re-asserting the current state is a no-op.
	 */
	get live(): boolean {
		return this._live;
	}
	set live(value: boolean) {
		if (value === this._live) {
			return;
		}
		this._live = value;
		this._observationShift(this, value ? 1 : -1);
	}
}

/** The resident-state edges the render lifecycle consumes (provided by the
 * engine's composition site). */
export type RenderPassDeps = {
	/** The observation index's refcount shift (observation.ts `shift`) — the
	 * watcher liveness seam feeds it, generation-checked. */
	obsShift(node: AnyNode, delta: 1 | -1): void;
};

export type RenderPassTable = {
	renderStart(rootId: RootId, includeBatches: BatchId[]): RenderPass;
	renderYield(id: RenderPassId): void;
	renderResume(id: RenderPassId): void;
	mountWatcher(renderPassId: RenderPassId, node: AnyNode, name: string): Watcher;
	deferMountEffects(watcherId: WatcherId): void;
	adoptRevealedMount(renderPassId: RenderPassId, watcherId: WatcherId): void;
	renderWatcher(renderPassId: RenderPassId, watcherId: WatcherId): void;
	removeWatcher(watcherId: WatcherId): void;
	commitBatches(rootId: RootId, batches: Iterable<BatchId>): boolean;
	renderEnd(id: RenderPassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: BatchId[] }): void;
	dependencyClosureOf(nodeId: NodeId, render?: RenderPass): Set<NodeId>;
	/** Stale-watcher loud skips (the dormant-watcher aliasing pin) —
	 * diagnostics/test surface. */
	staleWatcherSkips(): number;
};

export function createRenderPass(core: EngineCore, deps: RenderPassDeps): RenderPassTable {
	// Stable resident containers and tables, aliased once (identity-shared).
	const idToNode = core.idToNode;
	const idToRenderPass = core.idToRenderPass;
	const rootToOpenRender = core.rootToOpenRender;
	const watchers = core.watchers;
	const nodeToWatchers = core.nodeToWatchers;
	const batch = core.batch;
	const idToBatch = batch.idToBatch;
	const slots = batch.slots;
	const notify = core.notify;

	let nextRenderPassId = 1;
	let nextWatcher = 1;

	/** Stale-watcher loud skips (the dormant-watcher aliasing pin): every
	 * watcher→node
	 * resolution that MISSED — the watcher's record tenancy moved (freed,
	 * possibly reused) — and was skipped instead of silently binding the
	 * record's current tenant. Diagnostics/test surface. */
	let staleWatcherSkips = 0;

	/**
	 * THE watcher→node resolution: the idToNode probe plus the generation
	 * check against the watcher's mount-time stamp. Every consumer site
	 * (commit activation, mount fixup, drains, deliveries' correction loops,
	 * observation flips) resolves through here; a miss means the watcher's
	 * node record died (and its id may already name a NEW tenant — the
	 * dormant-watcher aliasing case), so the site must skip, loudly, never
	 * bind. Tenancy generations only grow, so a stale stamp never
	 * re-validates.
	 */
	function resolveWatcherNode(w: Watcher): AnyNode | undefined {
		const node = idToNode.get(w.node);
		if (node === undefined || kernelGenOf(w.node) !== w.nodeRecordGen) {
			staleWatcherSkips++;
			return undefined;
		}
		return node;
	}

	/** The watcher liveness seam (one closure per engine; Watcher._observationShift):
	 * generation-checked — a stale watcher's liveness flips shift nothing
	 * (skips pair up: tenancy generations only ever grow, so a stale stamp
	 * can never re-validate between a skipped retain and its release). */
	const watcherObs = (w: Watcher, delta: 1 | -1): void => {
		const node = resolveWatcherNode(w);
		if (node !== undefined) deps.obsShift(node, delta);
	};

	function minLivePin(): Seq {
		let min = Number.POSITIVE_INFINITY;
		for (const p of rootToOpenRender.values()) if (p.pin < min) min = p.pin;
		return min;
	}

	// ------------------------------------------------------ render lifecycle

	/**
	 * Open a render pass: pin frozen at start, render mask captured from
	 * live batches, committed set snapshotted — everything the render world
	 * folds is fixed here, so pause/resume cannot drift. One
	 * work-in-progress render per root (a same-root restart is a new render).
	 */
	function renderStart(rootId: RootId, includeBatches: BatchId[]): RenderPass {
		if (rootToOpenRender.has(rootId)) {
			throw new ScheduleError(`root ${rootId} already has an open render — one render pass per root at a time`);
		}
		const maskBatches = new Set<BatchId>();
		let maskBits = 0;
		for (const id of includeBatches) {
			const t = batch.batchById(id);
			if (t.state !== 'live') throw new ScheduleError('mask captures live batches only — a retired batch is already permanent history');
			maskBatches.add(id);
			// A live batch with no slot never wrote; if it writes later, those
			// log entries postdate this render's pin and the visibility rule's
			// included-up-to-pin clause excludes them anyway.
			if (t.slot !== undefined) maskBits |= 1 << t.slot;
		}
		// The committed-set capture materializes the root record (reference-model
		// parity: the model's committedSlotsNow() creates it on first consult).
		const includedBits = maskBits | core.root(rootId).committedBits;
		const render: RenderPass = {
			id: nextRenderPassId++, root: rootId, pin: core.getSeq(),
			maskBatches, maskBits, includedBits,
			state: 'open', endKind: undefined, mounted: [], rendered: new Set(),
		};
		// Claim the render's world arena from the pool — the render
		// world's value+invalidation+routing layer.
		render.arena = core.claimArena('render', { kind: 'render', render }, rootId);
		idToRenderPass.set(render.id, render);
		rootToOpenRender.set(rootId, render);
		core.recomputeQuiet(); // an open render: the pipeline is armed until it closes
		const tr = core.trace;
		if (tr !== undefined) {
			tr.renderStart(render);
			tr.opEnd();
		}
		return render;
	}

	function renderPassById(id: RenderPassId): RenderPass {
		return mustGet(idToRenderPass, id, 'render pass');
	}

	/** Yield/resume edges: while yielded, code that runs in the gap (event
	 * handlers, other renders) is "not in render" for this render. */
	function renderYield(id: RenderPassId): void {
		const p = renderPassById(id);
		if (p.state !== 'open') throw new ScheduleError('yield requires an open (running) render');
		p.state = 'yielded';
		const tr = core.trace;
		if (tr !== undefined) {
			tr.renderYield(p);
			tr.opEnd();
		}
	}

	function renderResume(id: RenderPassId): void {
		const p = renderPassById(id);
		if (p.state !== 'yielded') throw new ScheduleError('resume requires a yielded render');
		p.state = 'open';
		const tr = core.trace;
		if (tr !== undefined) {
			tr.renderResume(p);
			tr.opEnd();
		}
	}

	/** Mount a new watcher inside an open render; it renders in the render's world. */
	function mountWatcher(renderPassId: RenderPassId, node: AnyNode, name: string): Watcher {
		const p = renderPassById(renderPassId);
		if (p.state === 'ended') throw new ScheduleError('mount requires an open render');
		const value = core.evaluate(node, { kind: 'render', render: p });
		const watcher = new Watcher(nextWatcher++, name, p.root, node.id, node.ix, kernelGenOf(node.id), watcherObs, value, {
			renderPassId: p.id, pin: p.pin,
			maskBits: p.maskBits, includedBits: p.includedBits,
			rootCommitGen: core.root(p.root).commitGen,
		});
		watchers.set(watcher.id, watcher);
		let nodeWatchers = nodeToWatchers[node.ix];
		if (nodeWatchers === undefined) {
			nodeWatchers = [];
			nodeToWatchers[node.ix] = nodeWatchers;
		}
		nodeWatchers.push(watcher);
		p.mounted.push(watcher.id); // mounts never join `rendered` (the collections are disjoint)
		return watcher;
	}

	/**
	 * Reveal-shaped mounts (React's Offscreen/Activity: a hidden tree is
	 * prepared and committed without attaching its effects): the mounting
	 * render commits but the watcher's layout effects (subscribe + fixup)
	 * defer to a later, adopting commit — the reveal.
	 */
	function deferMountEffects(watcherId: WatcherId): void {
		for (const p of idToRenderPass.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
	}

	function adoptRevealedMount(renderPassId: RenderPassId, watcherId: WatcherId): void {
		const adopter = renderPassById(renderPassId);
		if (adopter.state === 'ended') throw new ScheduleError('adopting render must be open');
		const w = mustGet(watchers, watcherId, 'watcher');
		if (w.root !== adopter.root) throw new ScheduleError('reveal stays on the watcher root');
		for (const p of idToRenderPass.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
		adopter.mounted.push(watcherId);
	}

	/** An existing live watcher re-rendered by a render: dedup bits re-arm at
	 * render (the queued work the bits stood for has now started). */
	function renderWatcher(renderPassId: RenderPassId, watcherId: WatcherId): void {
		const p = renderPassById(renderPassId);
		if (p.state === 'ended') throw new ScheduleError('render requires an open render');
		const w = watchers.get(watcherId);
		if (w === undefined || !w.live) throw new ScheduleError('render targets a live watcher');
		if (w.root !== p.root) throw new ScheduleError('watcher belongs to another root');
		w.dedupBits = 0;
		p.rendered.add(watcherId);
	}

	/**
	 * Full watcher removal — the bindings' unsubscribe surface (debounce-
	 * finalized unsubscription, StrictMode orphan sweeps). The engine keeps
	 * watchers in TWO stores — the `watchers` id map and the `nodeToWatchers`
	 * per-node index the routing walks read (delivery collection, drain
	 * candidate collection, arena mark decay) — and this is the one public
	 * operation that retires a watcher from BOTH, plus any open render's
	 * mounted list (a dead watcher must not be revived by a later commit's
	 * layout loop). Deleting from the public map alone strands the per-node
	 * entry (pinned by tests/graph-consumers.spec.ts). The liveness setter
	 * inside releases the observation-union retain.
	 */
	function removeWatcher(watcherId: WatcherId): void {
		for (const p of idToRenderPass.values()) {
			const i = p.mounted.indexOf(watcherId);
			if (i >= 0) p.mounted.splice(i, 1);
		}
		dropWatcher(watcherId);
	}

	/** Unlinks a watcher from the per-node index (discarded mounts). */
	function dropWatcher(wid: WatcherId): void {
		const w = watchers.get(wid);
		if (w === undefined) return;
		// Deletion implies non-live: normally already false (discarded mounts
		// never subscribed), but if a driver discards a render holding an
		// adopted live watcher, this releases its observation retain
		// (edge-filtered no-op otherwise).
		w.live = false;
		watchers.delete(wid);
		// The cached index is safe here even when stale: a scrubbed row is
		// undefined, and a re-tenanted row cannot contain this watcher.
		const nodeWatchers = nodeToWatchers[w.nodeIx];
		if (nodeWatchers !== undefined) {
			const i = nodeWatchers.indexOf(w);
			if (i >= 0) nodeWatchers.splice(i, 1);
			// Reclamation retry trigger — the watcher-index guard row clears
			// here (removeWatcher, unmount/discard teardown all funnel through
			// this unlink). Edge-triggered: only the row's LAST entry leaving
			// clears the guard. Size-0 bail first.
			if (reclaimSkippedN !== 0 && nodeWatchers.length === 0) noteReclaimRetry(w.node);
		}
	}

	/**
	 * Per-root commit lock-in — THE single owner of a root's committed-state
	 * transition. For each named batch that is still live and not yet a
	 * committed member of this root, one unit moves TOGETHER: the committed-
	 * batch set, its bit-mask twin (`committedBits` — what the committed-world
	 * visibility check reads), the root's commit generation, the committed-
	 * advance clock, this root's arena fan-out of the batch's touched atoms,
	 * and the durable watcher drain. Already-committed, retired/reclaimed, and
	 * unknown batches skip: the protocol's per-root commit report is a delta,
	 * and re-reporting a batch is defined as an idempotent set-add.
	 *
	 * Callers: renderEnd's lock-in sweep (already inside its own operation
	 * frame, via the inner form) and the bindings' root-commit report handler
	 * (this public form — the report can name a live batch the render-end sweep
	 * missed). Returns whether any batch was newly locked in.
	 */
	function commitBatches(rootId: RootId, batches: Iterable<BatchId>): boolean {
		let changed = false;
		core.opDepth++; // public-operation frame (see the engine's write dispatch)
		try {
			changed = commitBatchesInner(rootId, batches);
			// Boundary rule: a per-root commit is a boundary operation. When this
			// call moved committed truth, re-check the root's committed
			// subscriptions at the boundary value (renderEnd's sweep gets the same
			// re-check from renderEnd's own boundary; here the call IS the
			// boundary). A no-op call re-checks nothing — the report's common
			// case re-names batches the sweep already locked in.
			if (changed) core.revalidateCommittedSubs(rootId);
			core.endOp();
		} finally {
			core.opDepth--;
		}
		core.arenaOpEpilogue();
		return changed;
	}

	function commitBatchesInner(rootId: RootId, batches: Iterable<BatchId>): boolean {
		const root = core.root(rootId);
		const tr = core.trace;
		let changed = false;
		for (const tid of batches) {
			const t = idToBatch.get(tid);
			if (t === undefined || t.state !== 'live') continue; // retired (or reclaimed): the retired clause subsumes membership
			if (root.committedBatches.has(t.id)) continue; // idempotent set-add: already a member
			root.committedBatches.add(t.id);
			if (t.slot !== undefined) root.committedBits |= 1 << t.slot;
			root.commitGen++;
			core.advanceCommitted(); // committed-advance: every per-root commit bumps it
			// Committed-truth flip site: per-root lock-in — inside the per-batch
			// loop (commits lock in SETS of batches), immediately after the
			// membership/gen/committedAdvance mutation and before this batch's drain, fan
			// THAT batch's touched atoms into THIS root's arena.
			{
				const ra = core.rootToArena.get(rootId);
				if (ra !== undefined) core.fanAtomsToArena(ra, t.atomsTouched, false);
			}
			if (tr !== undefined) tr.perRootCommit(rootId, t.id, root.commitGen);
			// Durable drain, gated exactly as before: an advanced slot or
			// member-slot write drift (or restaled leftovers) means the root's
			// committed truth moved — candidates come from the arena's dirty
			// list, which the lock-in fanout just fed.
			const bits = (t.slot !== undefined ? 1 << t.slot : 0) | root.committedDirtySlots;
			root.committedDirtySlots = 0;
			const re = core.restaled.get(rootId);
			if (bits !== 0 || (re !== undefined && re.size > 0)) core.drainCommittedObservers(rootId, 'per-root-commit');
			changed = true;
		}
		return changed;
	}

	/**
	 * End a render. Commit order: (1) baseline capture, (2) retirement folds
	 * due at this commit + per-root table update, (3) durable drains,
	 * (4) layout (subscribe + mount fixups) — the same order the protocol
	 * host performs the corresponding React work, so observers see states in
	 * the order the screen does. Discard: render-owned mounts die (the tree
	 * they rendered into never existed). Deferred slot releases re-evaluate
	 * at EVERY render end, commit and discard alike (the mask retaining a slot
	 * may just have closed).
	 */
	function renderEnd(id: RenderPassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: BatchId[] }): void {
		core.opDepth++; // public-operation frame (see the engine's write dispatch)
		try {
			renderEndInner(id, kind, opts);
		} finally {
			core.opDepth--;
		}
		core.arenaOpEpilogue();
	}

	function renderEndInner(id: RenderPassId, kind: 'commit' | 'discard', opts?: { retireAtCommit?: BatchId[] }): void {
		const render = renderPassById(id);
		if (render.state === 'ended') throw new ScheduleError('render already ended');
		if (kind === 'commit') {
			for (const tid of opts?.retireAtCommit ?? []) {
				const t = batch.batchById(tid); // throws on unknown ids before any mutation
				if (!render.maskBatches.has(tid)) {
					// A retirement folded inside a commit must belong to a batch
					// this commit rendered: folding a foreign batch's log entries here
					// would advance committed truth past what this commit actually
					// put on screen. Foreign batches retire at their own closure —
					// the protocol host never sends this shape; guarded anyway.
					throw new ScheduleError(`batch ${tid} is not rendered by render pass ${render.id}; its retirement cannot be due at this commit`);
				}
				if (t.state !== 'live' || t.parked) {
					throw new ScheduleError(`batch ${tid} cannot retire at this commit (already retired, or parked)`);
				}
			}
		}
		// Resolve mask batch records BEFORE any retirement can reclaim them:
		// the mount fixup's fast-path clock check quantifies over the
		// committing render's mask BATCHES as they exist at commit time (see
		// mountFixup for why batches, not captured slots).
		const maskBatchRecords: Batch[] = [];
		if (kind === 'commit') {
			for (const tid of render.maskBatches) maskBatchRecords.push(batch.batchById(tid));
		}
		render.state = 'ended';
		render.endKind = kind;
		rootToOpenRender.delete(render.root);
		// One load covers this operation's record sites: the disposition
		// record here fires BEFORE the end's consequences (retirement folds,
		// per-root commits, drains, fixups) so consequences can cite it as
		// cause; the renderCommitted/renderDiscarded checkpoint markers below
		// fire AFTER them (the reference model's stream position).
		const tr = core.trace;
		if (tr !== undefined) tr.renderEnd(render, kind);
		if (kind === 'discard') {
			for (const wid of render.mounted) dropWatcher(wid); // never subscribed; the tree died
			if (tr !== undefined) tr.renderDiscarded(render);
			reevaluateDeferredReleases();
			reclaimAfterRenderEnd(render);
			core.recomputeQuiet(); // render closed (and its pin unblocked compaction): quiet may re-arm
			// Boundary rule: the frame close is the deferred flush point for
			// boundaries that occurred while this root's frame was open (the discard
			// itself advances nothing; committed truth may already have moved).
			core.revalidateCommittedSubs(render.root);
			core.endOp();
			return;
		}
		// (1) Baseline capture at the commit's committed-side entry.
		const baseline = { committedAdvance: core.getCommittedAdvance(), rootCommitGen: core.root(render.root).commitGen };
		// The committing tree's content: re-rendered watchers take this render's
		// world values NOW — a watcher's last rendered value updates only at
		// committed renders, and it is the comparator later drains reconcile
		// against.
		for (const wid of render.rendered) {
			const w = watchers.get(wid);
			if (w === undefined) continue; // removed mid-render
			const wNode = resolveWatcherNode(w);
			if (wNode === undefined) continue; // loud skip: record tenancy moved mid-render
			w.lastRenderedValue = core.evaluate(wNode, { kind: 'render', render });
			w.snapshot = {
				renderPassId: render.id, pin: render.pin, maskBits: render.maskBits,
				includedBits: render.includedBits, rootCommitGen: core.root(render.root).commitGen,
			};
		}
		// (2) retirement folds due at this commit; then the per-root commit
		// (lock-in) of every still-live mask batch: this root now shows those
		// batches' writes, so its committed world must include them. The
		// lock-in — including step (3), each newly committed batch's durable
		// drain — is commitBatchesInner, THE single owner of the transition;
		// the bindings' root-commit report handler is its other caller.
		for (const tid of opts?.retireAtCommit ?? []) batch.retireInternal(batch.batchById(tid));
		commitBatchesInner(render.root, render.maskBatches);
		// (4) layout: subscribe, then mount fixup (matching React's layout-
		// effect phase: after commit, before paint).
		for (const wid of render.mounted) {
			const w = watchers.get(wid);
			if (w === undefined) continue;
			// THE dormant-watcher aliasing pin: the watcher was mounted in this
			// render, but its node's record may have died (and been REUSED)
			// before this commit — the generation stamp decides. A stale
			// watcher never activates: binding it here would subscribe it to
			// the record's new tenant.
			const wNode = resolveWatcherNode(w);
			if (wNode === undefined) continue; // loud skip (counted)
			w.live = true;
			mountFixup(w, wNode, render, baseline, maskBatchRecords);
		}
		// The populator domain — the EXPLICIT union of this render's
		// re-renders and its OWN mounts (`rendered` and `mounted` are
		// disjoint). Adopted reveals stay out: their snapshot rides the
		// original hidden render (`snapshot.renderPassId !== render.id` — the same
		// same-render conjunct the mount fixup's fast path tests), and their
		// population keeps its pre-existing timing (a later committed
		// evaluation), not the adopting commit's.
		const populated: WatcherId[] = [...render.rendered];
		for (const wid of render.mounted) {
			const w = watchers.get(wid);
			if (w !== undefined && w.snapshot.renderPassId === render.id) populated.push(wid);
		}
		// Re-staled detection: a re-rendered watcher whose committed value
		// moved past its pin is stale again the moment its commit reset
		// lastRenderedValue; the NEXT durable drain reconciles it (the
		// reference model's full scan does the same, one drain later than
		// the flip). This loop is DECLARED LOAD-BEARING FOR ROUTING:
		// its committed evaluations populate the root's arena with the
		// full committed dep cone (strong + weak) of every watcher this render
		// re-rendered or mounted, before renderEnd returns — i.e., before any
		// post-commit write needs routing. (For a freshly mounted watcher the
		// value check is provably a no-op — mountFixup just reconciled it —
		// but the evaluation is its cone's one populator: the fixup's
		// fast-out path never evaluates, and mountFix folds are arena-free.)
		for (const wid of populated) {
			const w = watchers.get(wid);
			if (w === undefined || !w.live) continue;
			const wNode = resolveWatcherNode(w);
			if (wNode === undefined) continue; // loud skip (live ⇒ alive in practice; belt for binding-side flips)
			const committedNow = core.evaluate(wNode, { kind: 'committed', root: render.root });
			if (core.changedValue(wNode, w.lastRenderedValue, committedNow)) markRestaled(w);
		}
		// The population dev assert: after a commit of render P, every
		// live watcher P re-rendered or mounted has a shadow for its node in
		// the root's committed arena (the populator above ran; a miss here
		// means a future re-ordering broke the routing coverage argument).
		{
			const ra = core.rootToArena.get(render.root);
			for (const wid of populated) {
				const w = watchers.get(wid);
				if (w === undefined || !w.live) continue;
				if (ra === undefined || (w.nodeIx < ra.nodeToShadow.length ? ra.nodeToShadow[w.nodeIx]! : 0) === 0) {
					throw new InvariantViolation(`watcher-population rule: watcher ${w.name} has no shadow in root ${render.root}'s committed arena after commit`);
				}
			}
		}
		if (tr !== undefined) tr.renderCommitted(render);
		// ctx.previous cells hold the last COMMITTED value — a pending
		// render's value must never leak into the hint, because a pending
		// transition may still be discarded — so update them from every
		// watcher this commit re-rendered or mounted: the explicit union of
		// the two disjoint collections, each watcher visited once (the cells
		// live on the engine's computed nodes, beside their ctx adapter).
		for (const wid of [...render.rendered, ...render.mounted]) {
			const w = watchers.get(wid);
			if (w === undefined || w.lastRenderedValue instanceof SuspendedRead) continue;
			const node = idToNode.get(w.node);
			if (node === undefined || kernelGenOf(w.node) !== w.nodeRecordGen) continue; // stale: no hint to update (not a resolution consumers observe — uncounted)
			if (node.kind === 'computed') node.prevCell.value = w.lastRenderedValue;
		}
		{
			const ra = core.rootToArena.get(render.root);
			if (ra !== undefined) core.arenaDecay(ra); // boundary mark decay
		}
		reevaluateDeferredReleases();
		reclaimAfterRenderEnd(render);
		core.recomputeQuiet(); // render closed (and its pin unblocked compaction): quiet may re-arm
		// Boundary rule: ONE committed-subscription re-check per commit
		// operation, at the boundary value — a render locking in two batches
		// re-checks once, not per batch.
		// Retirements folded into this commit moved committed truth for every
		// root, so the scan widens (each root still open-frame-deferred).
		core.revalidateCommittedSubs((opts?.retireAtCommit ?? []).length > 0 ? undefined : render.root);
		core.endOp();
	}

	/**
	 * Mid-episode reclamation, render-end site: the ended render record drops
	 * (its memos and mask mappings die with it — nothing from a dead render
	 * can validate later), and its mask batches re-check reclaimability
	 * (the mask retention just lapsed).
	 */
	function reclaimAfterRenderEnd(p: RenderPass): void {
		idToRenderPass.delete(p.id);
		// Drop the render arena (commit and discard drop identically;
		// this site deliberately runs AFTER mount fixup and the re-staled
		// loop, so both saw the arena; touching it later throws).
		if (p.arena !== undefined) {
			core.releaseArena(p.arena);
			p.arena = undefined;
		}
		for (const tid of p.maskBatches) {
			const t = idToBatch.get(tid);
			if (t !== undefined) batch.maybeReclaimBatch(t);
		}
	}

	/** Deferred releases re-evaluate at every render end, commit and discard alike. */
	function reevaluateDeferredReleases(): void {
		for (const s of slots) {
			if (!s.releasePending) continue;
			if (!batch.slotRetainedByOpenMask(s.id)) batch.releaseSlot(s);
		}
		// A render ending releases its pin, which can unblock pin-gated compaction.
		core.compactAll();
	}

	/**
	 * Watchers re-staled by their own commit: the commit reset
	 * lastRenderedValue to the render world's pin-old value while committed
	 * truth had already moved past the pin. The reference model catches
	 * these at its next full-scan drain; the engine keeps the precise set
	 * (`core.restaled`) and folds it into the next durable drain on the
	 * watcher's root.
	 */
	function markRestaled(w: Watcher): void {
		let set = core.restaled.get(w.root);
		if (set === undefined) {
			set = new Set();
			core.restaled.set(w.root, set);
		}
		set.add(w);
	}

	// ---------------------------------------------------------- mount fixup

	/** Every slot in `bits` has its last write at or before `pin` (the
	 * fast-out's clock conjunct, quantified over a snapshot's slot bits). */
	function slotClocksQuiet(bits: BatchSlotSet, pin: Seq): boolean {
		for (let s = 0; bits !== 0; s++, bits >>>= 1) {
			if ((bits & 1) === 1 && slots[s]!.writeClock > pin) return false;
		}
		return true;
	}

	/**
	 * Mount fixup — runs in the mounting component's layout effect (after
	 * commit, before paint), after subscription. Why it exists: a component
	 * can mount while other updates are in flight, and its subscription only
	 * activates at commit, so writes could slip by unobserved between its
	 * render and its commit. Two halves, decided in this order:
	 *  1. catch-up (no evaluation; write metadata only): a value-blind
	 *     corrective re-render joins each live batch that touched the node
	 *     but was not part of this render — the component joins the pending
	 *     update in that batch's own lane instead of revealing it early or
	 *     missing it;
	 *  2. urgent correction: whatever committed or retired during the mount
	 *     window is fixed before paint. The four-condition test decides
	 *     FIRST: when every condition passes, nothing committed or retired
	 *     in the window and any remaining drift is exactly the live-batch
	 *     writes step 1 already scheduled catch-ups for
	 *     (tests/concurrent-scars.spec.ts pins why those must NOT be
	 *     corrected urgently) — so nothing
	 *     else runs, no evaluation, no comparison. Only when a condition
	 *     fails is the node re-evaluated in the fast-forwarded mount-fix
	 *     world and a real difference corrected urgently.
	 * One subtle rule, asserted by the lockstep tests: the clock condition
	 * quantifies over the committing render's member BATCHES at commit time
	 * (not just the slot set captured at render start — a batch whose first
	 * write landed mid-render interned its slot after the capture, so the
	 * slot-quantified form would miss its writes).
	 */
	function mountFixup(w: Watcher, node: AnyNode, committingRender: RenderPass, baseline: { committedAdvance: Seq; rootCommitGen: CommitGen }, maskBatchRecords: Batch[]): void {
		const closure = dependencyClosureOf(w.node, committingRender);
		const tr = core.trace; // one load covers the corrective records + the disposition record
		// Catch-up half — per-batch catch-up loop: every LIVE written batch
		// that touched the node. A premise of the condition test's soundness,
		// not an optimization: a live committed member can write after the pin
		// without tripping any condition (its slot is outside the render
		// mask), and this schedule is what carries such writes.
		let correctives = 0;
		for (const b of idToBatch.values()) {
			if (b.state !== 'live' || b.slot === undefined) continue;
			if (!batchTouches(b, closure)) continue;
			const slot = slots[b.slot]!;
			// Fully included (slot ∈ included bits ∧ no post-pin write): skip — never by value.
			if (((w.snapshot.includedBits >>> slot.id) & 1) === 1 && slot.writeClock <= w.snapshot.pin) continue;
			if (tr !== undefined) tr.mountCorrective(w, b.id, slot.id);
			correctives++;
			w.dedupBits |= 1 << slot.id; // the corrective is a state update scheduled into the batch's lane (the protocol's runInBatch)
			if (core.onMountCorrective !== undefined) notify.queueNotify(1, w, b, slot.id);
		}
		// Urgent-correction half — the four-condition test, decided before any
		// evaluation: same render, no committed-truth advance, no per-root
		// commit, clocks quiet. The clock condition checks the captured mask
		// slots AND the committing render's mask batches at commit time — a mask
		// batch whose first write interned its slot mid-render is invisible to
		// the slot-quantified form, because the slot set was captured at render
		// start, before that slot existed.
		const clocksQuiet =
			slotClocksQuiet(w.snapshot.maskBits, w.snapshot.pin) &&
			maskBatchRecords.every((t) => t.lastWriteSeq === 0 || t.lastWriteSeq <= w.snapshot.pin);
		const fastOut =
			w.snapshot.renderPassId === committingRender.id &&
			baseline.committedAdvance <= w.snapshot.pin &&
			baseline.rootCommitGen === w.snapshot.rootCommitGen &&
			clocksQuiet;
		if (fastOut) {
			if (tr !== undefined) tr.mountFixup(w, 'fast-out', correctives);
			return; // nothing committed or retired in the window: no evaluation, no comparison
		}
		const vFx = core.evaluate(node, {
			kind: 'mountFix', maskBits: w.snapshot.maskBits, pin: w.snapshot.pin, root: w.root,
		});
		if (core.correctWatcher(w, node, vFx, 'mount')) {
			if (tr !== undefined) tr.mountFixup(w, 'corrected', correctives);
			return;
		}
		if (tr !== undefined) tr.mountFixup(w, 'compare-clean', correctives);
	}

	/** Transitive dependency closure feeding a node — three
	 * reverse (deps-direction) walks over kernel ∪ the mounting render's arena
	 * ∪ the root's committed arena. The kernel leg walks the KERNEL's own
	 * dep links (tracked-only by construction, evaluation-lagged
	 * exactly like every other recorded structure), mapping visited kernel
	 * records back to engine nodes; unregistered intermediates
	 * are traversed but contribute nothing (only engine-written atoms can
	 * appear in batch touch sets). STRONG links only (weak deps never
	 * joined the closure — they can't deliver, so correctives never target
	 * their batches). The render arena is alive here by ordering (fixup
	 * runs before reclaimAfterRenderEnd). The corrective population this
	 * closure
	 * feeds arms the per-(watcher, slot) dedup bits, so it must cover every
	 * cone the delivery walk can later route — render + committed arenas + the
	 * newest structure — or a suppression would degrade into an
	 * over-delivery (the model-comparison corpus's ⊆ delivery bound polices
	 * exactly this). */
	function dependencyClosureOf(nodeId: NodeId, render?: RenderPass): Set<NodeId> {
		const closure = new Set<NodeId>([nodeId]);
		const node = idToNode.get(nodeId);
		if (node === undefined) return closure; // unregistered/dead id: nothing routes
		const pa = render?.arena;
		if (pa !== undefined) core.closureOverArena(pa, node, closure);
		if (render !== undefined) {
			const ca = core.rootToArena.get(render.root);
			if (ca !== undefined) core.closureOverArena(ca, node, closure);
		}
		closureOverKernel(node.id, closure, new Set());
		return closure;
	}

	/** The kernel leg of the fixup closure: reverse walk over the
	 * kernel's dep links off the raw arena view (the kernel's own exported
	 * layout enums). One id space: a visited record's id IS the NodeId —
	 * registered deps join the closure directly. */
	function closureOverKernel(kernelId: NodeId, closure: Set<NodeId>, seen: Set<NodeId>): void {
		if (seen.has(kernelId)) return;
		seen.add(kernelId);
		const memory = E.buffer();
		let l = memory[kernelId + NodeField.DEPS]!;
		while (l !== 0) {
			const depKernelId = memory[l + LinkField.DEP]!;
			if (idToNode.has(depKernelId)) closure.add(depKernelId);
			if ((memory[depKernelId + NodeField.FLAGS]! & NodeFlag.K_COMPUTED) !== 0) closureOverKernel(depKernelId, closure, seen);
			l = memory[l + LinkField.NEXT_DEP]!;
		}
	}

	function batchTouches(t: Batch, closure: Set<NodeId>): boolean {
		const atoms = t.atomsTouched;
		for (let i = 0; i < atoms.length; i++) {
			if (closure.has(atoms[i]!.id)) return true;
		}
		return false;
	}

	// ---- the operation table (late-bound onto the shared core record) ----
	core.resolveWatcherNode = resolveWatcherNode;
	core.minLivePin = minLivePin;

	return {
		renderStart,
		renderYield,
		renderResume,
		mountWatcher,
		deferMountEffects,
		adoptRevealedMount,
		renderWatcher,
		removeWatcher,
		commitBatches,
		renderEnd,
		dependencyClosureOf,
		staleWatcherSkips: () => staleWatcherSkips,
	};
}
