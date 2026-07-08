/**
 * Delivery — the notification queue and the walk orchestration that decides
 * who gets notified. Two layers, two factories:
 *
 *  - `createNotificationQueue`: the queue mechanism — listener callbacks
 *    queued during a public operation's own mutations and DELIVERED AT THE
 *    OPERATION BOUNDARY (queued into reusable columns during the walk and
 *    invoked
 *    after the operation's mutations complete, so a listener can never
 *    re-enter a half-finished operation). The listener slots themselves
 *    (`onDelivery` / `onMountCorrective` / `onCorrection` — the bindings'
 *    consumption surface) live on the shared engine core record and come in
 *    through the `getCore` dep here (the queue is built before the core
 *    record exists, so the record arrives through a getter, read at flush
 *    time).
 *  - `createDeliveryWalks`: the ORCHESTRATION over the shared engine core
 *    record — the value-blind per-write delivery walk (which calls
 *    WorldArena's strong-link walks through the core's late-bound slots),
 *    the durable drain at committed-truth flips, the quiet-fold drain, and
 *    `correctWatcher`, the one urgent pre-paint correction every
 *    compare-and-correct site shares.
 *
 * Both are factories in the kernel's own style (index.ts `createKernel`):
 * each closes over its state and returns/assigns its operation table. The
 * queue's two live scalars (`n`, `flushing`) sit in one shared `state`
 * record the engine aliases, so its resident hot checks (the quiet-write
 * flush guard, the settle tap's flushing guard) stay plain field reads
 * instead of calls.
 */

import { committedNodeClock, getKernelGeneration } from './CosignalEngine.js';
import type { Batch, BatchSlot, BatchSlotMeta } from './Batch.js';
import type { AnyInternals, AtomInternals, RootId, Seq, Subscription, Value, Watcher } from './concurrent.js';
import type { EngineCore, World } from './World.js';

/** The queued-notification kinds (the notify columns' kind codes). Same-file
 * const enum with its one consumer, the flush loop; resident enqueue sites
 * pass the bare 0-3 codes (numeric literals are assignable, so cross-module
 * callers never name this type — cross-module const enum access does not
 * survive esbuild). */
const enum NotifyKind {
	DELIVERY = 0,
	MOUNT_CORRECTIVE = 1,
	CORRECTION = 2,
	SUBSCRIPTION_REFIRE = 3,
}

/** The two live queue scalars (shared record — see the module header). */
export type NotifyState = { n: number; flushing: boolean };

export type NotificationQueueDeps = {
	/** The shared core record's listener slice (`onDelivery` — a value-blind
	 * delivery reached a live watcher; `onMountCorrective` — mount fixup
	 * scheduled a corrective re-render into a live batch's lane;
	 * `onCorrection` — an urgent pre-paint correction). A getter because the
	 * queue is composed before the core record exists; the flush reads the
	 * slots per queued item, so a listener detaching mid-flush takes effect
	 * for the remaining items. */
	getCore(): Pick<EngineCore, 'onDelivery' | 'onMountCorrective' | 'onCorrection'>;
};

export type NotificationQueue = {
	state: NotifyState;
	queueNotify(kind: NotifyKind, w: Watcher | undefined, t: Batch | undefined, slot: BatchSlot, sub?: Subscription): void;
	flushNotify(): void;
};

export function createNotificationQueue(deps: NotificationQueueDeps): NotificationQueue {
	// Queued-notification columns (reused across operations; no per-notify objects).
	const notifyKinds: number[] = [];
	const notifyWs: (Watcher | undefined)[] = [];
	const notifyBatches: (Batch | undefined)[] = [];
	const notifySlots: BatchSlot[] = [];
	const notifySubs: (Subscription | undefined)[] = [];
	const state: NotifyState = { n: 0, flushing: false };

	function queueNotify(kind: NotifyKind, w: Watcher | undefined, t: Batch | undefined, slot: BatchSlot, sub?: Subscription): void {
		const i = state.n++;
		notifyKinds[i] = kind;
		notifyWs[i] = w;
		notifyBatches[i] = t;
		notifySlots[i] = slot;
		notifySubs[i] = sub;
	}

	/** Invokes queued listeners at the end of the public operation. A nested
	 * public operation started BY a listener appends behind the live bound
	 * and drains in the same sweep (the flushing flag stops nested sweeps). */
	function flushNotify(): void {
		if (state.n === 0 || state.flushing) return;
		// The core record's identity is stable for the whole composition; the
		// listener SLOTS are read per item below (live reads — a listener
		// detaching mid-flush takes effect for the remaining items).
		const core = deps.getCore();
		state.flushing = true;
		try {
			for (let i = 0; i < state.n; i++) {
				const kind = notifyKinds[i]!;
				const w = notifyWs[i];
				const t = notifyBatches[i];
				const s = notifySubs[i];
				notifyWs[i] = undefined; // release object refs eagerly
				notifyBatches[i] = undefined;
				notifySubs[i] = undefined;
				if (kind === NotifyKind.DELIVERY) {
					const l = core.onDelivery;
					if (l !== undefined) l(w!, t!, notifySlots[i]!);
				} else if (kind === NotifyKind.MOUNT_CORRECTIVE) {
					const l = core.onMountCorrective;
					if (l !== undefined) l(w!, t!, notifySlots[i]!);
				} else if (kind === NotifyKind.CORRECTION) {
					const l = core.onCorrection;
					if (l !== undefined) l(w!);
				} else if (s !== undefined && s.live) {
					// Subscription refire (adapter-registered): the value gate
					// already passed at the boundary scan; the adapter owns the
					// body run (cleanup + fire + re-capture) and any React-phase
					// deferral. Removal flips `live`, so nothing runs after
					// teardown.
					const r = s.refire;
					if (r !== undefined) r();
				}
			}
		} finally {
			state.n = 0;
			state.flushing = false;
		}
	}

	return { state, queueNotify, flushNotify };
}

/**
 * The walk ORCHESTRATION: the per-write delivery walk, the durable
 * drain, the quiet-fold drain, and the one urgent correction — assigned onto
 * the shared engine core record's late-bound slots (the arena walk halves it
 * calls — `walkArenaStrong`, `collectWatchersAt`,
 * `arenaCollectDrainCandidates` — live in the engine module, same-file with
 * the layout enums; the watcher resolution lives in its render-integration
 * section; all are read off the core record at call time).
 */
export function createDeliveryWalks(core: EngineCore): void {
	// Stable resident containers, aliased once (identity-shared).
	const notify = core.notify;
	const watchers = core.watchers;
	const rootToOpenRender = core.rootToOpenRender;

	/** Reused delivery-walk collection buffer (walks are never re-entrant). */
	const walkWatchers: Watcher[] = [];

	/** Reused durable-drain candidate buffer (drains are never re-entrant). */
	const drainWatcherBuf: Watcher[] = [];

	/**
	 * The value-blind delivery walk: reachability from the written
	 * atom over EVERY live arena's STRONG links — render arenas included; the
	 * walk visits structure, never values or marks, so a render's frozen pin
	 * is untouched. The weak bit is tested and weak links are
	 * never traversed (untracked reads never notify; the bit test
	 * is the walk's whole per-link cost for that rule). Kernel (K0)
	 * subscribers are served by the eager kernel apply, not this walk.
	 * Value-blind: a
	 * delivery announces "a write in this batch may affect you", never a
	 * value — the receiving render folds its own world. Collected watchers
	 * dedup globally per node (lastWalk) across arenas and deliver in id
	 * order (the reference model's map order). Deliveries may be FEWER than
	 * the model's union-conservative set, never more: a cone
	 * held by no live arena is still corrected — it degrades to the
	 * committed-truth drain instead of a live delivery.
	 */
	function deliveryWalk(from: AtomInternals, batch: Batch, slot: BatchSlotMeta, seq: Seq): void {
		const c = core; // one context load; slot/field reads below stay one-load
		const gen = ++c.walkGen;
		const found = walkWatchers;
		found.length = 0;
		const kGen = getKernelGeneration(from.id); // one read per walk: seeds validate tenancy against it
		c.lastWalk[from.ix] = gen;
		c.collectWatchersAt(from.ix, found);
		for (const a of c.rootToArena.values()) c.walkArenaStrong(a, from.ix, kGen, gen, found);
		for (const p of rootToOpenRender.values()) {
			if (p.arena !== undefined) c.walkArenaStrong(p.arena, from.ix, kGen, gen, found);
		}
		if (found.length > 1) found.sort((a, b) => a.id - b.id);
		for (let i = 0; i < found.length; i++) deliver(found[i]!, batch, slot, seq);
		found.length = 0;
	}

	/**
	 * Delivery — per-write, value-blind, in the writer's stack. The
	 * per-(watcher, slot) dedup bit suppresses a repeat delivery only when
	 * scheduled-but-unstarted work will fold the write anyway; otherwise
	 * deliver interleaved so no write can slip between renders unseen.
	 */
	function deliver(w: Watcher, batch: Batch, slot: BatchSlotMeta, seq: Seq): void {
		const tr = core.trace; // one load covers this call's (at most two) record sites
		const bit = 1 << slot.id;
		if ((w.dedupBits & bit) === 0) {
			w.dedupBits |= bit;
			if (tr !== undefined) tr.delivery(w, batch.id, slot.id, seq, false);
			if (core.onDelivery !== undefined) notify.queueNotify(0, w, batch, slot.id);
			return;
		}
		// Bit set: suppress iff no started-and-uncommitted render on the
		// watcher's root includes this slot (render mask) with pin < the
		// write's sequence — such a render froze BEFORE this write, so it would
		// fold without it and a fresh delivery is still required.
		// One open render per root ⇒ one registry load + two compares.
		const p = rootToOpenRender.get(w.root);
		if (p !== undefined && ((p.maskBits >>> slot.id) & 1) === 1 && p.pin < seq) {
			if (tr !== undefined) tr.delivery(w, batch.id, slot.id, seq, true);
			if (core.onDelivery !== undefined) notify.queueNotify(0, w, batch, slot.id);
		} else {
			if (tr !== undefined) tr.suppressed(w, batch.id, slot.id, seq);
		}
	}

	/** The one urgent pre-paint watcher correction (gate → record → resets →
	 * notify). A correction must move the rendered register, advance the
	 * lastValidatedAt stamp, re-arm the dedup bits, and queue the kind-2
	 * notify together — all four correction sites (settlement drain, quiet
	 * drain, durable drain, mount fixup) share this body so the tuple can
	 * never drift. The gate is split by the at-least-once contract:
	 *
	 *  - Drain causes (retirement / per-root-commit / quiet) gate on CLOCKS:
	 *    the candidate's evaluation just settled the watched node's per-root
	 *    committed clock, and a correction fires iff that clock differs from
	 *    the watcher's lastValidatedAt — no value comparison. Flip-flops
	 *    whose intermediate states were refolded re-fire spuriously by
	 *    accepted design; the stamp advances here (the urgent correction is
	 *    a validation).
	 *  - TWO cross-world cases keep the value compare, because per-root
	 *    committed clocks cannot express equivalence between two different
	 *    worlds: the mount fixup (cause 'mount' — a mountFix-world value
	 *    against the rendered register; it does not stamp — the commit
	 *    populator right after it owns the watcher's validation) and
	 *    candidates re-rendered or mounted by the CURRENTLY COMMITTING
	 *    render (core.committingRender — their register was just reset from
	 *    the render world, and the commit's own lock-in bumps the committed
	 *    clock for exactly the content the screen already shows, so a clock
	 *    gate would correct every watcher at every commit; a firing
	 *    correction here reconciles against committed-now, so it stamps).
	 *
	 * Records by cause: drains record reconcile-correction; mounts record
	 * mount-correction (decoded as 'mount-urgent-correction'); quiet folds
	 * record nothing here — the fold's own quiet-write record is the whole
	 * quiet stream, and the reference model's mirrored quiet corrections are
	 * silent too, so the streams stay comparable. Returns true iff a
	 * correction fired. */
	function correctWatcher(w: Watcher, wInternals: AnyInternals, now: Value, cause: 'retirement' | 'per-root-commit' | 'quiet' | 'mount'): boolean {
		const committing = core.committingRender;
		if (cause === 'mount' || (committing !== undefined && w.snapshot.renderPassId === committing.id)) {
			// Cross-world gate (the value compare per-root clocks cannot replace).
			if (!core.isValueChanged(wInternals, w.lastRenderedValue, now)) return false;
			if (cause !== 'mount') {
				const a = core.rootToArena.get(w.root);
				if (a !== undefined) w.lastValidatedAt = committedNodeClock(a, w.nodeIx);
			}
		} else {
			const a = core.rootToArena.get(w.root);
			const clockNow = a === undefined ? 0 : committedNodeClock(a, w.nodeIx);
			if (clockNow === w.lastValidatedAt) return false;
			w.lastValidatedAt = clockNow;
		}
		if (cause !== 'quiet') {
			const tr = core.trace;
			if (tr !== undefined) {
				if (cause === 'mount') tr.mountCorrection(w, w.lastRenderedValue, now);
				else tr.reconcileCorrection(w, w.root, w.lastRenderedValue, now, cause === 'per-root-commit');
			}
		}
		w.lastRenderedValue = now; // the urgent pre-paint re-render
		w.dedupBits = 0; // dedup bits re-arm at the watcher's render
		if (core.onCorrection !== undefined) notify.queueNotify(2, w, undefined, 0);
		return true;
	}

	/** Value-gated watcher reconciliation for a quiet fold: committed truth
	 * moved for every root, and no slot/walk state exists to scope candidates,
	 * so every live watcher re-checks directly — the same compare-and-correct
	 * block as drainCommittedObservers. (Committed subscriptions re-check via
	 * revalidateCommittedSubscriptions at the same boundary.) */
	function quietDrain(): void {
		const c = core; // one context load; slot reads below stay one-load
		for (const w of watchers.values()) {
			if (!w.live) continue;
			const wInternals = c.resolveWatcherInternals(w);
			if (wInternals === undefined) continue; // loud skip: record tenancy moved
			const now = c.evaluate(wInternals, { kind: 'committed', root: w.root });
			// The drain is an observer consult: settle the watched node's
			// committed clock before the correction gate reads it.
			const a = c.rootToArena.get(w.root);
			if (a !== undefined) c.settleObserverClock(a, wInternals);
			correctWatcher(w, wInternals, now, 'quiet');
		}
	}

	/**
	 * Durable drain at a committed-truth flip (a retirement or per-root
	 * commit): the candidate set is the root arena's DIRTY LIST —
	 * the fanout sites' marks, whose cones the marks' PENDING propagation
	 * already covers — expanded over all arena links, strong and weak
	 * (drains expand over both; a weak hop's strong dependents
	 * expand past it too, since the walk keeps going), collecting live
	 * same-root watchers on visited nodes, unioned with the `restaled` set.
	 * Reconcile-check each candidate (last rendered value vs
	 * committed-for-root now; urgent pre-paint correction on real
	 * difference — comparing values is legal here because both sides are
	 * committed truth, whereas live-write delivery must stay value-blind).
	 * Candidates fire in id order (the reference model's map order). List
	 * entries persist until decay drops them, and consumed marks still seed
	 * conservatively — extras are value-gated no-ops, exactly as the old
	 * slot touched lists were. Committed SUBSCRIPTIONS do not drain here:
	 * their re-check is once per boundary operation
	 * (revalidateCommittedSubscriptions).
	 */
	function drainCommittedObservers(rootId: RootId, cause: 'retirement' | 'per-root-commit'): void {
		const c = core; // one context load; slot/field reads below stay one-load
		const world: World = { kind: 'committed', root: rootId };
		const gen = ++c.walkGen; // per-node collection dedup + per-arena traversal stamps
		const lastWalk = c.lastWalk;
		const ws = drainWatcherBuf;
		ws.length = 0;
		// Candidate collection: the root arena's dirty list seeds a
		// walk over all arena links — weak included (the walk itself lives in
		// CosignalEngine.ts's world-arena sections, same-file with the enums).
		const a = c.rootToArena.get(rootId);
		if (a !== undefined && a.dirty.length !== 0) {
			c.arenaCollectDrainCandidates(a, gen, rootId, ws);
		}
		{
			const re = c.restaled.get(rootId);
			if (re !== undefined && re.size > 0) {
				for (const w of re) {
					if (!w.live) continue;
					if (lastWalk[w.nodeIx] === gen) continue; // its node was already listed (cached index; valid while the gen-checked fire below resolves)
					ws.push(w);
				}
				re.clear();
			}
		}
		if (ws.length > 1) ws.sort((a, b) => a.id - b.id);
		for (let i = 0; i < ws.length; i++) {
			const w = ws[i]!;
			const wInternals = c.resolveWatcherInternals(w);
			if (wInternals === undefined) continue; // loud skip: record tenancy moved
			const now = c.evaluate(wInternals, world);
			// The drain is an observer consult: settle the watched node's
			// committed clock before the correction gate reads it.
			if (a !== undefined) c.settleObserverClock(a, wInternals);
			correctWatcher(w, wInternals, now, cause);
		}
		ws.length = 0;
	}

	// ---- the operation table (late-bound onto the shared core record) ----
	core.correctWatcher = correctWatcher;
	core.quietDrain = quietDrain;
	core.drainCommittedObservers = drainCommittedObservers;
	core.deliveryWalk = deliveryWalk;
}
