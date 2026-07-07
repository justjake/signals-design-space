/**
 * SUBSCRIPTIONS — the ONE core `run`-action consumer record (committed
 * observers, the production useSignalEffect mechanism) and its
 * lifecycle: registration, the capture frame that snapshots deps under the
 * committed world, removal, the test-side replay surface, and the
 * boundary revalidation. `deliver`-action consumers (component re-renders)
 * remain `Watcher` structurally and stay with the engine. Core `effect()`s
 * hold no Subscription: they are REAL kernel effects, flushed by the eager
 * kernel apply (their trace seam, `logCoreEffectRun`, stays with the
 * engine's trace sites).
 *
 * `createSubscriptionManager` is a factory in the kernel's own style: it
 * closes over the subscription store and returns its operation table (the
 * `SubscriptionManager`); the engine
 * aliases the store and the public operations, wires the boundary
 * revalidation into the shared core record (the resident orchestration —
 * retirement, render end, quiet fold — and the settlement drain call it as
 * table calls), and provides the resident-state edges through `deps`.
 */

import { SuspendedRead } from './index.js';
import { ScheduleError } from './errors.js';
import type { AnyInternals, SubscriptionId, RootId, Value } from './concurrent.js';
import type { EngineCore, World } from './World.js';
import type { ObservationIndex } from './observation.js';

/**
 * The ONE core `run`-action subscription record: the production
 * `useSignalEffect` mechanism, shared with the test suites (one record type,
 * one firing machinery). A subscription is a
 * registration saying WHO is notified and IN WHICH WORLD its reads resolve;
 * `deliver`-action consumers (component re-renders) remain `Watcher`
 * structurally — only the firing machinery is shared. `deps` is the
 * (node, value) snapshot `captureRun` recorded
 * under the committed world of the subscription's root; re-checks are
 * value-gated over it and fire at the boundary operations (per-root
 * commit, retirement, settlement, quiet fold; one re-check per boundary
 * operation, at the boundary value, never while the subscription's own root
 * has an open render frame — deferred flips flush at that frame's
 * close). `refire` (adapter-registered) rides the operation-boundary
 * notification queue; test-configured subscriptions (tests/helpers.ts's
 * mountEngineReactEffect/-Pick) store a `body` and re-run it inline through
 * the SAME capture frame, so the model-comparison suites exercise the real
 * mechanism.
 *
 * Core `effect()`s hold no Subscription: they are REAL kernel effects,
 * flushed by the eager kernel apply (see logCoreEffectRun).
 */
export type Subscription = {
	id: SubscriptionId;
	name: string;
	/** Owning root. */
	root: RootId;
	/** Dep snapshot: the routed reads of the last run, in read order. */
	deps: { node: AnyInternals; value: Value }[];
	/** Adapter-owned refire (cleanup + body scheduling), queued at the
	 * operation boundary; undefined for test-configured subscriptions. */
	refire: (() => void) | undefined;
	/** Test-configured body (re-run inline through the capture frame). */
	body: (() => void) | undefined;
	/** Last captured value (the last dep read). */
	lastValue: Value;
	runs: number;
	cleanups: number;
	live: boolean;
	/** Snapshot nodes currently holding observation retains
	 * (re-pointed per run exactly like watcher obsDeps; see the observation
	 * index's shiftObservedCount).
	 * Node OBJECTS, not ids: a retained node's record can free and re-tenant
	 * while the stale reference lingers, and shiftObservedCount's identity
	 * guard is
	 * what keeps the eventual release from touching the new tenant. */
	obsDeps: Set<AnyInternals> | undefined;
};

/** The core capture frame `captureRun` opens: while set (and no evaluation
 * world is on stack) routed reads resolve committed-for-root and append to
 * the dep snapshot. The FIELD lives
 * on the shared engine core record (the read-routing resolution consults it
 * per routed read); this module is its one writer, through the core's
 * `setCaptureFrame`. */
export type CaptureFrame = { sub: Subscription; deps: { node: AnyInternals; value: Value }[] };

/** The resident-state edges the manager consumes (provided by the engine's
 * composition site), as named slices of the providers' own record types:
 *  - `core`: the shared engine core record (World.ts `EngineCore`) — the
 *    evaluation/gate operations, the resident containers, and the mutable
 *    core fields this manager reads live (trace slot, capture frame,
 *    evaluation/fold guards) or owns every transition of
 *    (`committedSubCount`, the live-count fast-bail scalar — core-resident
 *    so the resident and settlement pre-checks stay plain field reads;
 *    `captureFrame`, written only through `setCaptureFrame` so read routing
 *    re-syncs with every assignment).
 *  - `observation`: the observation index (observation.ts) — the
 *    subscription snapshot re-pointer and the refcount shift that releases
 *    a removed snapshot's retains. */
export type SubscriptionManagerDeps = {
	core: Pick<
		EngineCore,
		| 'evaluate'
		| 'changedValue'
		| 'root'
		| 'rootToOpenRender'
		| 'notify'
		| 'setCaptureFrame'
		| 'trace'
		| 'captureFrame'
		| 'evalDepth'
		| 'inFoldCallback'
		| 'committedSubCount'
	>;
	observation: Pick<ObservationIndex, 'syncSubscriptionObservation' | 'shiftObservedCount'>;
};

export type SubscriptionManager = {
	/** The committed `run`-action subscription store (shared identity: the
	 * engine aliases it for its resident readers — quiesce sweep, tests). */
	idToSubscription: Map<SubscriptionId, Subscription>;
	mountCommittedObserver(rootId: RootId, name: string, refire?: () => void): Subscription;
	captureRun(id: SubscriptionId, body: () => void): void;
	captureRead(node: AnyInternals): Value;
	removeSubscription(id: SubscriptionId): void;
	replayReactEffect(id: SubscriptionId): void;
	revalidateCommittedSubscriptions(rootFilter: RootId | undefined): void;
};

export function createSubscriptionManager(deps: SubscriptionManagerDeps): SubscriptionManager {
	// Composition-time locals (the codegen doctrine): every function a warm
	// path calls binds once; mutable core state (trace, captureFrame, the
	// guards, the live count) stays plain field reads off the aliased record.
	const core = deps.core;
	const { evaluate, changedValue, root, setCaptureFrame } = core;
	const rootToOpenRender = core.rootToOpenRender;
	const { queueNotify, flushNotify } = core.notify;
	const { syncSubscriptionObservation, shiftObservedCount } = deps.observation;
	const idToSubscription = new Map<SubscriptionId, Subscription>();
	let nextSubscriptionId = 1;

	/**
	 * Register a committed observer (the production `useSignalEffect`
	 * surface). Registration is illegal inside an open evaluation frame —
	 * the record is committed-consumer state; it must never exist for a
	 * discarded render attempt (the render-stack half of the
	 * guard is adapter-enforced, since "on a render call stack" is a host
	 * predicate). The caller then runs `captureRun` from the host's effect
	 * phase to take the first dep snapshot.
	 */
	function mountCommittedObserver(rootId: RootId, name: string, refire?: () => void): Subscription {
		if (core.evalDepth > 0 || core.inFoldCallback) {
			throw new ScheduleError('effect registration is illegal inside an open evaluation/fold frame');
		}
		const sub: Subscription = {
			id: nextSubscriptionId++, name, root: rootId,
			deps: [], refire, body: undefined, lastValue: undefined,
			runs: 0, cleanups: 0, live: true, obsDeps: undefined,
		};
		root(rootId);
		idToSubscription.set(sub.id, sub);
		core.committedSubCount += 1;
		return sub;
	}

	// (The test-side convenience constructors mountReactEffect /
	// mountReactEffectPick — 4-line compositions of mountCommittedObserver +
	// a `body` + captureRun — live in tests/helpers.ts. The
	// `body` mechanism itself stays here: it is the inline-run + event-creation
	// path the model-comparison suites drive.)

	/**
	 * Runs a subscription body under the core capture frame: the effective
	 * world becomes committed-for-root, every routed read (raw atom reads
	 * through the routed-read resolution, engine computed reads through
	 * `captureRead`) appends to the dep snapshot, and reads INSIDE a
	 * computed's own evaluation stay the computed's (the evaluation world on
	 * stack outranks the frame). A mid-body
	 * throw installs the partial snapshot: the deps read before the throw are
	 * real dependencies. After the frame closes, the snapshot's observation
	 * retains re-point (effect deps count toward the observation union
	 * exactly like watcher closures — the observation index's
	 * shiftObservedCount).
	 */
	function captureRun(id: SubscriptionId, body: () => void): void {
		const sub = idToSubscription.get(id);
		if (sub === undefined) throw new ScheduleError(`unknown committed subscription ${id}`);
		if (core.captureFrame !== undefined) throw new ScheduleError('captureRun frames do not nest — one effect body runs at a time');
		if (core.evalDepth > 0) throw new ScheduleError('captureRun is illegal inside an open evaluation frame');
		const frame = { sub, deps: [] as { node: AnyInternals; value: Value }[] };
		setCaptureFrame(frame);
		try {
			body();
		} finally {
			setCaptureFrame(undefined);
			sub.deps = frame.deps;
			sub.lastValue = frame.deps.length === 0 ? undefined : frame.deps[frame.deps.length - 1]!.value;
			// Observation re-point AFTER the frame closes, so discovery
			// evaluations run on a clean frame stack (same rule as
			// syncObservedDeps).
			syncSubscriptionObservation(sub);
		}
	}

	/** A routed read inside an open capture frame (node form: test-configured
	 * bodies land here; raw kernel atom AND computed reads route through the
	 * routed-read seams instead, which push the same dep-snapshot entries). */
	function captureRead(node: AnyInternals): Value {
		const frame = core.captureFrame;
		if (frame === undefined) throw new ScheduleError('captureRead requires an open captureRun frame');
		const v = evaluate(node, { kind: 'committed', root: frame.sub.root });
		frame.deps.push({ node, value: v });
		return v;
	}

	/**
	 * Remove a subscription (unmount / teardown). Cleanup invocation is the
	 * REGISTRAR's job (the adapter runs the user cleanup; test
	 * configurations count it here) — guaranteed at unmount, while a make-up
	 * fire is not. Nothing may run after teardown:
	 * `live` flips so queued refires no-op.
	 */
	function removeSubscription(id: SubscriptionId): void {
		const sub = idToSubscription.get(id);
		if (sub === undefined) throw new ScheduleError(`unknown subscription ${id}`);
		sub.live = false;
		idToSubscription.delete(id);
		core.committedSubCount -= 1;
		sub.cleanups++;
		const tr = core.trace;
		if (tr !== undefined) tr.reactEffectCleanup(sub.name, sub.root);
		// Release the snapshot's observation retains.
		const held = sub.obsDeps;
		if (held !== undefined) {
			sub.obsDeps = undefined;
			for (const dep of held) shiftObservedCount(dep, -1);
		}
	}

	/** Test surface — StrictMode-style replay: cleanup + unconditional
	 * re-run + recapture. Illegal while the subscription's root has an open
	 * render frame (React double-invokes effects post-commit, never mid-render). */
	function replayReactEffect(id: SubscriptionId): void {
		const sub = idToSubscription.get(id);
		if (sub === undefined) throw new ScheduleError(`unknown react effect ${id}`);
		if (rootToOpenRender.has(sub.root)) {
			throw new ScheduleError('replay requires the effect root to have no open render frame');
		}
		runCommittedSubscription(sub);
		flushNotify();
	}

	/** The inline re-fire (test-configured `body` subscriptions): cleanup +
	 * body re-run through the REAL capture
	 * frame + records (adapter-registered subscriptions instead queue their
	 * refire to the operation boundary — the adapter owns the body run). */
	function runCommittedSubscription(sub: Subscription): void {
		if (sub.refire !== undefined) {
			queueNotify(3, undefined, undefined, 0, sub);
			return;
		}
		sub.cleanups++;
		const tr = core.trace;
		if (tr !== undefined) tr.reactEffectCleanup(sub.name, sub.root);
		if (sub.body !== undefined) captureRun(sub.id, sub.body);
		sub.runs++;
		// The dep-values array is the ONE per-record payload a site allocates,
		// and only under the guard: the model-comparison suites compare it
		// entry by entry, so the record must carry the real snapshot.
		if (tr !== undefined) tr.reactEffectRun(sub.name, sub.root, sub.lastValue, sub.deps.map((d) => d.value));
	}

	/**
	 * The boundary re-check: once per boundary
	 * OPERATION — per-root commit, retirement, settlement, quiet fold —
	 * value-gated over each subscription's dep snapshot, at the boundary
	 * value (multiple member writes coalesce), and NEVER while the
	 * subscription's own root has an open render frame (the deferred
	 * flip flushes at that frame's close — commit or discard). A retirement
	 * re-checks every root (a write-free retirement still flushes pending
	 * member-write flips); a plain commit re-checks its own root. Runs at the
	 * END of the boundary operation, after every committed-side mutation of
	 * the boundary has landed (the same mutate-then-notify ordering every
	 * boundary shares).
	 */
	function revalidateCommittedSubscriptions(rootFilter: RootId | undefined): void {
		if (core.committedSubCount === 0) return;
		for (const sub of [...idToSubscription.values()]) {
			if (!sub.live) continue;
			if (rootFilter !== undefined && sub.root !== rootFilter) continue;
			if (rootToOpenRender.has(sub.root)) continue; // deferred to the frame's close
			const world: World = { kind: 'committed', root: sub.root };
			let changed = false;
			for (let i = 0; i < sub.deps.length; i++) {
				const d = sub.deps[i]!;
				let now: Value;
				try {
					now = evaluate(d.node, world);
				} catch (err) {
					if (err instanceof SuspendedRead) continue; // still-pending suspension: not a flip (pinned in tests/concurrent-battery.spec.ts)
					throw err;
				}
				if (changedValue(d.node, d.value, now)) {
					changed = true;
					break;
				}
			}
			if (changed) runCommittedSubscription(sub);
		}
	}

	return {
		idToSubscription,
		mountCommittedObserver,
		captureRun,
		captureRead,
		removeSubscription,
		replayReactEffect,
		revalidateCommittedSubscriptions,
	};
}
