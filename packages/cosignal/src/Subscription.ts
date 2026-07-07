/**
 * SUBSCRIPTIONS — the ONE core `run`-action consumer record (committed
 * observers, the PROMOTED production useSignalEffect mechanism) and its
 * lifecycle: registration, the capture frame that snapshots deps under the
 * committed world, removal, the referee replay surface, and the RCC-EF2
 * boundary revalidation. `deliver`-action consumers (component re-renders)
 * remain `Watcher` structurally and stay with the engine. Core `effect()`s
 * hold no Subscription: they are REAL kernel effects, flushed by the eager
 * kernel apply (their referee seam, `logCoreEffectRun`, stays with the
 * engine's trace sites).
 *
 * `createSubscription` is a factory in the kernel's own style: it closes
 * over the subscription store and returns its operation table; the engine
 * aliases the store and the public operations, wires the boundary
 * revalidation into the shared core record (the resident orchestration —
 * retirement, render end, quiet fold — and the settlement drain call it as
 * table calls), and provides the resident-state edges through `deps`.
 */

import { SuspendedRead } from './index.js';
import { ScheduleError } from './errors.js';
import type { AnyNode, EffectId, RenderPass, RootId, RootState, TraceHooks, Value } from './concurrent.js';
import type { World } from './World.js';
import type { DeliverTable } from './deliver.js';

/**
 * The ONE core `run`-action subscription record (effects unification by
 * promotion, plans/2026-07-06): the PROMOTED production `useSignalEffect`
 * mechanism (previously the adapter's EffectRec). A subscription is a
 * registration saying WHO is notified and IN WHICH WORLD its reads resolve;
 * `deliver`-action consumers (component re-renders) remain `Watcher`
 * structurally — their state is untouched, the unification is of the firing
 * machinery. `deps` is the (node, value) snapshot `captureRun` recorded
 * under the committed world of the subscription's root; re-checks are
 * value-gated over it and fire at RCC-EF2's amended BOUNDARIES (per-root
 * commit, retirement, settlement, quiet fold; one re-check per boundary
 * operation, at the boundary value, never while the subscription's own root
 * has an open render-pass frame — deferred flips flush at that frame's
 * close). `refire` (adapter-registered) rides the operation-boundary
 * notification queue; referee-configured subscriptions (tests/helpers.ts's
 * mountEngineReactEffect/-Pick) store a `body` and re-run it inline through
 * the SAME capture frame, so lockstep referees the real mechanism.
 *
 * Core `effect()`s hold no Subscription: they are REAL kernel effects,
 * flushed by the eager kernel apply (see logCoreEffectRun).
 */
export type Subscription = {
	id: EffectId;
	name: string;
	/** Owning root. */
	root: RootId;
	/** Dep snapshot: the routed reads of the last run, in read order. */
	deps: { node: AnyNode; value: Value }[];
	/** Adapter-owned refire (cleanup + body scheduling), queued at the
	 * operation boundary; undefined for referee-configured subscriptions. */
	refire: (() => void) | undefined;
	/** Referee-configured body (re-run inline through the capture frame). */
	body: (() => void) | undefined;
	/** Last captured value (the last dep read). */
	lastValue: Value;
	runs: number;
	cleanups: number;
	live: boolean;
	/** RCC-OL1: snapshot nodes currently holding observation retains
	 * (re-pointed per run exactly like watcher obsDeps; see obsShift).
	 * Node OBJECTS, not ids: a retained node's record can free and re-tenant
	 * while the stale reference lingers, and obsShift's identity guard is
	 * what keeps the eventual release from touching the new tenant. */
	obsDeps: Set<AnyNode> | undefined;
};

/** The core capture frame `captureRun` opens: while set (and no evaluation
 * world is on stack) routed reads resolve committed-for-root and append to
 * the dep snapshot. Replaces the adapter's effectCapture + readObserver
 * seam + the world provider's committed arm (plan §2.2.2). The FIELD lives
 * on the shared engine core record (the read-routing resolution consults it
 * per routed read); this module is its one writer, through
 * `deps.setCaptureFrame`. */
export type CaptureFrame = { sub: Subscription; deps: { node: AnyNode; value: Value }[] };

/** The resident-state edges the mechanism consumes (provided by the engine's
 * composition site; arrows over engine/core state or resident orchestration). */
export type SubscriptionDeps = {
	/** World evaluation (World.ts — the core's late-bound slot, passed as the
	 * real closure: the World factory is composed first). */
	evaluate(node: AnyNode, world: World): Value;
	/** §4.5.3 value-change gate honoring custom-equality computeds (resident). */
	changedValue(node: AnyNode, prev: Value, next: Value): boolean;
	/** Root record lookup-or-create (resident registry). */
	root(id: RootId): RootState;
	/** The one open render per root (identity alias — the open-frame deferral checks). */
	rootToOpenRender: Map<RootId, RenderPass>;
	/** The notification queue (refires ride the operation boundary). */
	notify: DeliverTable;
	/** The engine's trace recorder slot (undefined unless a tracer attached). */
	trace(): TraceHooks | undefined;
	/** The observation table's subscription re-pointer (observation.ts). */
	syncSubObs(sub: Subscription): void;
	/** The observation refcount shift (releasing a removed snapshot's retains). */
	obsShift(node: AnyNode, delta: 1 | -1): void;
	/** Assigns the capture frame AND re-syncs read routing (World.ts). */
	setCaptureFrame(f: CaptureFrame | undefined): void;
	/** The open capture frame (core state, read live). */
	captureFrame(): CaptureFrame | undefined;
	/** Open world-evaluation frames (registration/capture guards). */
	evalDepth(): number;
	/** The fold-purity flag (registration guard). */
	inFoldCallback(): boolean;
	/** The live-count fast-bail scalar, core-resident so the resident and
	 * settlement pre-checks stay plain field reads (this factory owns every
	 * transition). */
	subCountShift(delta: 1 | -1): void;
	committedSubCount(): number;
};

export type SubscriptionTable = {
	/** The committed `run`-action subscription store (shared identity: the
	 * engine aliases it for its resident readers — quiesce sweep, tests). */
	idToSubscription: Map<EffectId, Subscription>;
	mountCommittedObserver(rootId: RootId, name: string, refire?: () => void): Subscription;
	captureRun(id: EffectId, body: () => void): void;
	captureRead(node: AnyNode): Value;
	removeSubscription(id: EffectId): void;
	replayReactEffect(id: EffectId): void;
	revalidateCommittedSubs(rootFilter: RootId | undefined): void;
};

export function createSubscription(deps: SubscriptionDeps): SubscriptionTable {
	const idToSubscription = new Map<EffectId, Subscription>();
	let nextEffect = 1;

	/**
	 * Register a committed observer (the production `useSignalEffect`
	 * surface). Registration is illegal inside an open evaluation frame —
	 * the record is committed-consumer state; it must never exist for a
	 * discarded render attempt (contract §2 L3; the render-stack half of the
	 * guard is adapter-enforced, since "on a render call stack" is a host
	 * predicate). The caller then runs `captureRun` from the host's effect
	 * phase to take the first dep snapshot.
	 */
	function mountCommittedObserver(rootId: RootId, name: string, refire?: () => void): Subscription {
		if (deps.evalDepth() > 0 || deps.inFoldCallback()) {
			throw new ScheduleError('effect registration is illegal inside an open evaluation/fold frame');
		}
		const sub: Subscription = {
			id: nextEffect++, name, root: rootId,
			deps: [], refire, body: undefined, lastValue: undefined,
			runs: 0, cleanups: 0, live: true, obsDeps: undefined,
		};
		deps.root(rootId);
		idToSubscription.set(sub.id, sub);
		deps.subCountShift(1);
		return sub;
	}

	// (The referee convenience constructors mountReactEffect /
	// mountReactEffectPick — 4-line compositions of mountCommittedObserver +
	// a `body` + captureRun — live test-side now: tests/helpers.ts. The
	// `body` mechanism itself stays here: it is the inline-run + event-creation
	// path the lockstep referee compares.)

	/**
	 * Runs a subscription body under the core capture frame: the effective
	 * world becomes committed-for-root, every routed read (raw atom reads
	 * through the host read hook, bound/overlay computed reads through
	 * `captureRead`) appends to the dep snapshot, and reads INSIDE a
	 * computed's own evaluation stay the computed's (the evaluation world on
	 * stack outranks the frame — the promoted suppression rule). A mid-body
	 * throw installs the partial snapshot: the deps read before the throw are
	 * real dependencies. After the frame closes, the snapshot's observation
	 * retains re-point (RCC-OL1: effect deps count toward the union exactly
	 * like watcher closures — the obsShift observation index).
	 */
	function captureRun(id: EffectId, body: () => void): void {
		const sub = idToSubscription.get(id);
		if (sub === undefined) throw new ScheduleError(`unknown committed subscription ${id}`);
		if (deps.captureFrame() !== undefined) throw new ScheduleError('captureRun frames do not nest — one effect body runs at a time');
		if (deps.evalDepth() > 0) throw new ScheduleError('captureRun is illegal inside an open evaluation frame');
		const frame = { sub, deps: [] as { node: AnyNode; value: Value }[] };
		deps.setCaptureFrame(frame);
		try {
			body();
		} finally {
			deps.setCaptureFrame(undefined);
			sub.deps = frame.deps;
			sub.lastValue = frame.deps.length === 0 ? undefined : frame.deps[frame.deps.length - 1]!.value;
			// Observation re-point AFTER the frame closes, so discovery
			// evaluations run on a clean frame stack (same rule as obsSyncDeps).
			deps.syncSubObs(sub);
		}
	}

	/** A routed read inside an open capture frame (bridge-node form: referee
	 * bodies land here; raw kernel atom AND computed reads route through the
	 * host read seams instead, which push the same dep-snapshot entries). */
	function captureRead(node: AnyNode): Value {
		const frame = deps.captureFrame();
		if (frame === undefined) throw new ScheduleError('captureRead requires an open captureRun frame');
		const v = deps.evaluate(node, { kind: 'committed', root: frame.sub.root });
		frame.deps.push({ node, value: v });
		return v;
	}

	/**
	 * Remove a subscription (unmount / teardown). Cleanup invocation is the
	 * REGISTRAR's job (the adapter runs the user cleanup; referee
	 * configurations count it here) — guaranteed at unmount, while a make-up
	 * fire is not (RCC-EF2 amended; RCC-OL2 forbids anything after teardown:
	 * `live` flips so queued refires no-op).
	 */
	function removeSubscription(id: EffectId): void {
		const sub = idToSubscription.get(id);
		if (sub === undefined) throw new ScheduleError(`unknown subscription ${id}`);
		sub.live = false;
		idToSubscription.delete(id);
		deps.subCountShift(-1);
		sub.cleanups++;
		const tr = deps.trace();
		if (tr !== undefined) tr.reactEffectCleanup(sub.name, sub.root);
		// Release the snapshot's observation retains.
		const held = sub.obsDeps;
		if (held !== undefined) {
			sub.obsDeps = undefined;
			for (const dep of held) deps.obsShift(dep, -1);
		}
	}

	/** Referee surface — StrictMode-style replay: cleanup + unconditional
	 * re-run + recapture. Illegal while the subscription's root has an open
	 * render frame (React double-invokes effects post-commit, never mid-render). */
	function replayReactEffect(id: EffectId): void {
		const sub = idToSubscription.get(id);
		if (sub === undefined) throw new ScheduleError(`unknown react effect ${id}`);
		if (deps.rootToOpenRender.has(sub.root)) {
			throw new ScheduleError('replay requires the effect root to have no open render frame');
		}
		runCommittedSub(sub);
		deps.notify.flushNotify();
	}

	/** The referee re-fire: cleanup + body re-run through the REAL capture
	 * frame + records (adapter-registered subscriptions instead queue their
	 * refire to the operation boundary — the adapter owns the body run). */
	function runCommittedSub(sub: Subscription): void {
		if (sub.refire !== undefined) {
			deps.notify.queueNotify(3, undefined, undefined, 0, sub);
			return;
		}
		sub.cleanups++;
		const tr = deps.trace();
		if (tr !== undefined) tr.reactEffectCleanup(sub.name, sub.root);
		if (sub.body !== undefined) captureRun(sub.id, sub.body);
		sub.runs++;
		// The dep-values array is the ONE per-record payload a site allocates,
		// and only under the guard: the lockstep referee compares it entry by
		// entry, so the record must carry the real snapshot.
		if (tr !== undefined) tr.reactEffectRun(sub.name, sub.root, sub.lastValue, sub.deps.map((d) => d.value));
	}

	/**
	 * The RCC-EF2 boundary re-check (amended, 2026-07-06): once per boundary
	 * OPERATION — per-root commit, retirement, settlement, quiet fold —
	 * value-gated over each subscription's dep snapshot, at the boundary
	 * value (multiple member writes coalesce), and NEVER while the
	 * subscription's own root has an open render-pass frame (the deferred
	 * flip flushes at that frame's close — commit or discard). A retirement
	 * re-checks every root (a write-free retirement still flushes pending
	 * member-write flips); a plain commit re-checks its own root. Runs at the
	 * END of the boundary operation, after every committed-side mutation of
	 * the boundary has landed (ordering joint, plan amendment 6).
	 */
	function revalidateCommittedSubs(rootFilter: RootId | undefined): void {
		if (deps.committedSubCount() === 0) return;
		for (const sub of [...idToSubscription.values()]) {
			if (!sub.live) continue;
			if (rootFilter !== undefined && sub.root !== rootFilter) continue;
			if (deps.rootToOpenRender.has(sub.root)) continue; // deferred to the frame's close
			const world: World = { kind: 'committed', root: sub.root };
			let changed = false;
			for (let i = 0; i < sub.deps.length; i++) {
				const d = sub.deps[i]!;
				let now: Value;
				try {
					now = deps.evaluate(d.node, world);
				} catch (err) {
					if (err instanceof SuspendedRead) continue; // still-pending suspension: not a flip (battery 16d)
					throw err;
				}
				if (deps.changedValue(d.node, d.value, now)) {
					changed = true;
					break;
				}
			}
			if (changed) runCommittedSub(sub);
		}
	}

	return {
		idToSubscription,
		mountCommittedObserver,
		captureRun,
		captureRead,
		removeSubscription,
		replayReactEffect,
		revalidateCommittedSubs,
	};
}
