/**
 * SETTLEMENT — the resource-settlement tap, its queue, the drain loop, and
 * the compound-operation epilogue (§4.5.4, step-0 shapes). A SETTLEMENT is a
 * suspended thenable resolving: the kernel's per-thenable shared listener
 * calls the tap, the tap queues the thenable's stable sentinel, and the
 * drain invalidates every arena shadow boxed on it, reconciles the touched
 * roots' committed observers, and re-checks committed subscriptions — the
 * EF2 settlement boundary. The operation epilogue (`arenaOpEpilogue`) is
 * what every public operation owes on exit: drain queued settlements to
 * empty (the fixed point), then the armed divergence check; `endOp` is the
 * compound-operation tail (trace opEnd mark + the queued-notification
 * flush).
 *
 * `createSettlement` is a factory in the kernel's own style: it closes over
 * the queue and its flags and assigns its operation table onto the shared
 * engine core record (World.ts `EngineCore`) — the drain reaches arenas,
 * world evaluation, resident corrections, and the subscription revalidation
 * through the core's late-bound slots at call time.
 */

import { SuspendedRead } from './index.js';
import { engineEpoch } from './graph.js';
import { InvariantViolation } from './errors.js';
import type { EngineCore } from './World.js';
import type { RootId } from './concurrent.js';

export function createSettlement(core: EngineCore): void {
	// Stable resident containers, aliased once (identity-shared).
	const notify = core.notify;
	const notifyState = core.notifyState;
	const rootToOpenRender = core.rootToOpenRender;
	const watchers = core.watchers;

	/** Pending-settlement queue + the sentinel queued bit (identity dedup). */
	let pendingSettle: SuspendedRead[] = [];
	const pendingSettleSet = new Set<SuspendedRead>();
	let settleDraining = false;
	let settleDrainScheduled = false;
	/** Step-0 termination: the settlement drain adopts the engine's flush
	 * bound discipline — an iteration cap with a diagnostic on breach; a
	 * chain of callbacks that synchronously settles ever-new thenables is
	 * USER feedback, the effect-loop equivalent. */
	let settleCap = 10_000;

	/** Test seam: shrink the settlement-drain iteration cap. @internal */
	function setSettleCap(n: number): void {
		settleCap = n;
	}

	/**
	 * The settle tap (§4.5.4 push half): called by the kernel's per-thenable
	 * shared listener after the status write. Create-on-tap is the FIRST act —
	 * the kernel's own lazy-create expression — so a synchronous custom
	 * thenable (whose callbacks fire before `unwrapThenable`'s throw creates
	 * `t.suspendSentinel`) still yields ONE sentinel identity shared with the later throw.
	 */
	function settleTap(t: PromiseLike<unknown>): void {
		const c = core; // one context load; field accesses below keep the one-load shape
		const th = t as PromiseLike<unknown> & { suspendSentinel?: SuspendedRead };
		const suspendSentinel = (th.suspendSentinel ??= new SuspendedRead(t));
		if (c.suspendedCount === 0 && pendingSettle.length === 0) return; // no arena suspensions anywhere
		if (pendingSettleSet.has(suspendSentinel)) return; // queued bit
		pendingSettleSet.add(suspendSentinel);
		pendingSettle.push(suspendSentinel);
		if (settleDraining || notifyState.flushing || c.opDepth !== 0 || c.evalDepth !== 0 || c.inFoldCallback) {
			// Mid-operation: the enclosing operation's epilogue (or the drain's
			// own next iteration) consumes it. Read-context settlement (S-A
			// step 0): an epilogue-less read frame — standalone committedValue/
			// renderValue — has no epilogue, so ALSO schedule ONE coalesced
			// microtask drain, the kernel's own attachSettle discipline
			// (queueMicrotask); it no-ops when an epilogue got there first.
			if (!settleDrainScheduled) {
				settleDrainScheduled = true;
				// ENGINE-EPOCH GUARD (cross-reset microtask discipline): a
				// drain scheduled by a dead test must not run this (dead)
				// composition's queue into the next test's time.
				const epoch = engineEpoch;
				queueMicrotask(() => {
					settleDrainScheduled = false;
					if (epoch !== engineEpoch) return;
					if (pendingSettle.length !== 0 && core.opDepth === 0 && core.evalDepth === 0 && !settleDraining && !notifyState.flushing) {
						settlementDrain();
					}
				});
			}
			return;
		}
		// At rest (the kernel's batchDepth === 0 arm): drain NOW — a
		// background-only suspended watcher or effect refires FROM the
		// settlement event itself; no unrelated operation is ever needed.
		settlementDrain();
	}

	/**
	 * The settlement drain — ONE queue-owning loop, the only consumer of the
	 * pending-settlement queue, identical at every drain site, and it OWNS
	 * the notification flush (S-A step 0): `flushNotify` is INSIDE the loop,
	 * so a refire callback that synchronously settles another thenable lands
	 * its sentinel in the queue and gets the NEXT iteration. The drain IS the
	 * EF2 settlement boundary; it never returns with a queued settlement
	 * unscanned or unflushed.
	 */
	function settlementDrain(): void {
		const c = core; // one context load; field accesses below keep the one-load shape
		if (settleDraining) return;
		settleDraining = true;
		c.opDepth++; // taps landing mid-drain enqueue (next iteration)
		try {
			let iter = 0;
			while (pendingSettle.length !== 0) {
				if (++iter > settleCap) {
					throw new InvariantViolation(
						`settlement drain exceeded ${settleCap} iterations — a settlement chain is synchronously settling ever-new thenables (user feedback, the effect-loop equivalent)`,
					);
				}
				const taken = pendingSettle;
				pendingSettle = [];
				for (let i = 0; i < taken.length; i++) pendingSettleSet.delete(taken[i]!);
				const touchedRoots = new Set<RootId>();
				for (let i = 0; i < taken.length; i++) {
					const suspendSentinel = taken[i]!;
					c.eachArena((a) => {
						// Scan the suspended list (dense — O(current suspensions),
						// §4.5.4) for shadows whose box payload IS this sentinel —
						// the arena half (marks + propagation + the read-clock
						// bump) lives with the layout enums: WorldArena.ts
						// arenaInvalidateSettled. The marks ARE the invalidation
						// (arenas serve world reads since S-B); committed roots
						// also join the cone drain below. Open-render arenas keep
						// their marks for the frame's close.
						if (c.arenaInvalidateSettled(a, suspendSentinel) && a.kind === 'committed') touchedRoots.add(a.root);
					});
					// (Newest suspensions need no eviction here since S-C: the
					// kernel's own attachSettle listener invalidates kernel-cached
					// suspensions at settlement, and boxedRead self-heals at reads.)
				}
				// Cone drain: value-gated committed re-checks of the touched
				// roots' live watchers (the durable-drain compare; the marks
				// fanned above drive the arena refolds), deferred for roots
				// with an open render frame (their close flushes).
				for (const rootId of touchedRoots) {
					if (rootToOpenRender.has(rootId)) continue;
					for (const w of watchers.values()) {
						if (!w.live || w.root !== rootId) continue;
						const wNode = c.resolveWatcherNode(w);
						if (wNode === undefined) continue; // loud skip: record tenancy moved
						c.correctWatcher(w, wNode, c.evaluate(wNode, { kind: 'committed', root: rootId }), 'retirement');
					}
				}
				// Boundary subscription scan + the flush the loop OWNS.
				// (Core effect()s need nothing here: settlements move world
				// visibility, never newest values, so the kernel is untouched.)
				if (c.committedSubCount !== 0) c.revalidateCommittedSubs(undefined);
				notify.flushNotify();
			}
		} finally {
			c.opDepth--;
			settleDraining = false;
		}
	}

	/** Public-operation epilogue (S-A): drain queued settlements to empty
	 * (the fixed point), then the divergence check when armed. BOTH halves
	 * are top-level-boundary work: a NESTED operation (R-3's effect writes
	 * during a fused apply run whole write/fold operations inside the outer
	 * one) must not drain or check mid-outer — the outer epilogue owes both
	 * once its own mutations complete. */
	function arenaOpEpilogue(): void {
		const c = core; // one context load; the depth/hook reads stay one-load
		if (c.opDepth !== 0) return; // nested operation: the outer epilogue owns the boundary
		if (pendingSettle.length !== 0 && !settleDraining) settlementDrain();
		if (c.epilogueCheck !== undefined) c.epilogueCheck();
	}

	/** The compound-operation tail every public exit owes, in order: the
	 * trace's opEnd mark (scopes causality), then the queued-notification
	 * flush. One copy — an exit that forgets either desyncs trace causality
	 * or strands queued notifies, so every exit calls this instead. */
	function endOp(): void {
		const tr = core.trace;
		if (tr !== undefined) tr.opEnd();
		notify.flushNotify();
	}

	/** Queue depth (diagnostics — the engine's __arenaStats). */
	function pendingSettleCount(): number {
		return pendingSettle.length;
	}

	// ---- the operation table (late-bound onto the shared core record) ----
	core.settleTap = settleTap;
	core.arenaOpEpilogue = arenaOpEpilogue;
	core.endOp = endOp;
	core.setSettleCap = setSettleCap;
	core.pendingSettleCount = pendingSettleCount;
}
