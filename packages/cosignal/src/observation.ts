/**
 * The observation index — the engine's transitive observation retains.
 * A node is OBSERVED while a live watcher consumes it — directly, or
 * transitively through the strong (tracked) dep edges of observed overlay
 * computeds. Observed ATOMS hold exactly one retain on the kernel's
 * observed-lifecycle union (AtomOptions.effect); the kernel's lifecycleShift
 * is a Map-miss no-op for atoms without the option, and these shifts fire
 * only at closure-membership EDGES (never per evaluation), so routing every
 * closure atom through it costs nothing measurable and needs no second
 * has-lifecycle registry here. obsDeps snapshots follow the CURRENT edge set
 * — each fn re-run of an observed computed (overlay newest runs AND arena
 * world refolds carry the capture) re-points its retains (dep flips move
 * them; the kernel's microtask flush coalesces same-tick flaps) — and the
 * observation index deliberately survives quiescence: the closure is a
 * property of live watchers, not of the episode.
 *
 * `createObservation` is a factory in the kernel's own style (index.ts
 * `createEngine`): it closes over the two dense per-nodeIndex columns and
 * returns its operation table. The columns are exposed on the table by
 * IDENTITY (the kernel's shared-side-column pattern): the engine aliases
 * them for its hot readers (evaluation frames probe `refs[ix] > 0` per
 * observed run) and its row maintenance (indexNode's gap-fill, the
 * record-free scrub), while every closure-membership transition routes
 * through the table's functions. The kernel retain seams
 * (`__lifecycleRetain`/`__lifecycleRelease`, the forced discovery read) are
 * consumed here, beside their one consumer.
 */

import { untracked, __lifecycleRelease, __lifecycleRetain } from './index.js';
import { E, noteReclaimRetry, reclaimSkippedN } from './graph.js';
import type { AnyNode, ComputedNode, Subscription } from './concurrent.js';

/** Dense per-node column key (NodeField.NODE_INDEX — see concurrent.ts). */
type NodeIndex = number;

export type ObservationDeps = {
	/** The dense node row by NODE INDEX (the identity guard's referee: a
	 * stale node object whose record re-tenanted must never shift the new
	 * tenant's count). */
	nodeAt(ix: NodeIndex): AnyNode | undefined;
	/** The registered bridge nodes among a computed's CURRENT kernel deps
	 * (tracked-only by construction — obsEnter's discovery source). */
	kernelStrongDepsOf(node: ComputedNode): AnyNode[];
};

export type ObservationTable = {
	/** Observed-consumer refcount per nodeIndex: +1 per live watcher on the
	 * node, +1 per observed computed currently holding it in obsDeps.
	 * (Shared identity — the engine aliases it; see the module header.) */
	refs: number[];
	/** Per OBSERVED computed (by nodeIndex): the retained direct strong-dep
	 * set as of its last fn run (undefined while unobserved — unwatched nodes
	 * store nothing). Sets hold node OBJECTS — see Subscription.obsDeps.
	 * (Shared identity — the engine aliases it.) */
	deps: (Set<AnyNode> | undefined)[];
	shift(node: AnyNode, delta: 1 | -1): void;
	exit(node: AnyNode): void;
	syncDeps(node: AnyNode, list: AnyNode[]): void;
	syncSubObs(sub: Subscription): void;
};

export function createObservation(deps: ObservationDeps): ObservationTable {
	const obsRefs: number[] = [0];
	const obsDeps: (Set<AnyNode> | undefined)[] = [undefined];

	/** Shift a node's observed-consumer refcount; enter/exit fire on the
	 * 0↔1 edges only, so shared consumers (two watchers on one derived node,
	 * two observed dependents of one dep) hold ONE closure membership.
	 * IDENTITY-GUARDED: shifts take the node OBJECT and no-op when the dense
	 * row no longer holds it — a stale reference (an obsDeps entry naming a
	 * freed node whose record — and nodeIndex — a new tenant inherited) must
	 * never move the new tenant's count. Skips pair up: once stale, forever
	 * stale (rows only move at record free, and re-registration installs a
	 * different object). */
	function obsShift(node: AnyNode, delta: 1 | -1): void {
		const ix = node.ix;
		if (deps.nodeAt(ix) !== node) return;
		const refs = obsRefs[ix]! + delta;
		obsRefs[ix] = refs;
		if (refs === 1 && delta === 1) obsEnter(node);
		else if (refs === 0 && delta === -1) {
			obsExit(node);
			// Reclamation retry trigger — the obsRefs guard row's clearing
			// site is THE release-to-zero edge itself, wherever it fires
			// (dependency recapture, subscription teardown, watcher release).
			if (reclaimSkippedN !== 0) noteReclaimRetry(node.id);
		}
	}

	/**
	 * A node joined the live-watcher closure. Atoms retain their kernel
	 * observed lifecycle (the watcher half of the observation union — the
	 * kernel liveness bit is the other). Computeds must discover their
	 * CURRENT strong dep set: since S-C that IS the kernel's dep-link list
	 * (tracked-only by construction, per-last-evaluation) — force one
	 * kernel read so the record has evaluated at least once, then retain
	 * the links it holds. The read runs under kernel `untracked()`: entry
	 * can fire inside an open kernel evaluation frame (a getter epilogue's
	 * dep sync), and the discovery is not a READ by that frame — a link
	 * would corrupt its dep list. A getter that throws keeps its
	 * throw-on-demand behavior; the deps it read before throwing ARE
	 * retained (the kernel keeps the partial link prefix).
	 */
	function obsEnter(node: AnyNode): void {
		if (node.kind === 'atom') {
			__lifecycleRetain(node.id);
			return;
		}
		try {
			untracked(() => E.computedRead(node.id));
		} catch {
			// partial dep prefix retained below
		}
		obsSyncDeps(node, deps.kernelStrongDepsOf(node));
	}

	/** The last observed consumer left: release the whole retained closure.
	 * obsDeps clears BEFORE the child shifts so a degenerate cyclic dep
	 * record (possible only via throwing getters) cannot re-release. (The
	 * node's kernel record keeps its links and cache: HOST_OWNED records
	 * never feed the D1 lifecycle union, and stripping them would force an
	 * untracked re-sample at the next read — an eager refresh the ruling
	 * forbids [2026-07-06].) */
	function obsExit(node: AnyNode): void {
		if (node.kind === 'atom') {
			__lifecycleRelease(node.id);
			return;
		}
		const held = obsDeps[node.ix];
		if (held === undefined) return;
		obsDeps[node.ix] = undefined;
		for (const dep of held) obsShift(dep, -1);
	}

	/**
	 * An observed computed's fn just ran (fully, or up to a throw): re-point
	 * its retains at the strong deps THIS evaluation recorded. Retain-new
	 * before release-old; deps present in both snapshots never shift, and
	 * an A→B→A flip within one tick nets out in the kernel's microtask
	 * flush. Skipped if observation left mid-evaluation (the exit already
	 * released the old snapshot; installing a new one would leak).
	 */
	function obsSyncDeps(node: AnyNode, list: AnyNode[]): void {
		if (obsRefs[node.ix]! === 0) return;
		const prev = obsDeps[node.ix];
		const next = new Set(list);
		obsDeps[node.ix] = next;
		for (const dep of next) {
			if (prev === undefined || !prev.delete(dep)) obsShift(dep, 1);
		}
		if (prev !== undefined) {
			for (const dep of prev) obsShift(dep, -1);
		}
	}

	/**
	 * A committed subscription's run just installed a new dep snapshot:
	 * re-point its observation retains (RCC-OL1 — effect dep snapshots count
	 * toward the observation union exactly like watcher closures: one retain
	 * per snapshot node through the obsShift observation index; an atom retains its
	 * kernel lifecycle, an observed computed retains its current strong deps
	 * transitively). Retain-new before release-old; same-tick flaps coalesce
	 * in the kernel's microtask flush. (The snapshot's routing coverage
	 * needs no counts since S-B: the capture's committed evaluations
	 * populate the root's arena, whose marks the re-checks validate
	 * through — §4.0's subDepRefs dissolution.)
	 */
	function syncSubObs(e: Subscription): void {
		const prev = e.obsDeps;
		const next = new Set<AnyNode>();
		for (let i = 0; i < e.deps.length; i++) next.add(e.deps[i]!.node);
		e.obsDeps = next;
		for (const dep of next) {
			if (prev === undefined || !prev.delete(dep)) obsShift(dep, 1);
		}
		if (prev !== undefined) {
			for (const dep of prev) obsShift(dep, -1);
		}
	}

	return { refs: obsRefs, deps: obsDeps, shift: obsShift, exit: obsExit, syncDeps: obsSyncDeps, syncSubObs };
}
