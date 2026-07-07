/**
 * SUSPENSE and the computed evaluation policy — what happens when a computed
 * evaluation cannot produce a plain value. A computed's function can throw,
 * or it can read async data that is not ready yet (`ctx.use` on a pending
 * thenable — a SUSPENSION). Rather than make every caller handle those
 * cases, the engine stores the RAW payload of what happened — the thrown
 * value, or the pending thenable — in the slot where the value would have
 * gone (the kernel's `values` side column) and marks the outcome in the
 * node's flags (NodeFlag.HAS_BOX, plus BOX_SUSPENDED for suspensions). This
 * module owns both halves of that story:
 *
 *  - the WRITE half, called from the kernel's two cold catch sites:
 *    `storeThrown` (store the payload, return the outcome bits, attach the
 *    settle listener on transition) and `attachSettle` (stale-guarded
 *    settlement-invalidate: when the pending thenable settles, the computed
 *    is marked stale exactly the way a dependency write would);
 *  - the READ half: `boxedRead`, the kernel's cold read tail — errors
 *    rethrow, settled suspensions self-heal, pending suspensions throw the
 *    thenable's stable `SuspendedRead` sentinel (declared here);
 *  - the EVALUATION CONTEXT's members: `ctxPrevious` and `ctxUse`, the
 *    hoisted functions behind the one `ctx` object the kernel passes every
 *    computed getter (graph.ts POLICY_CTX), with the thenable protocol
 *    (`unwrapThenable`, mirroring React's trackUsedThenable), the per-node
 *    keyed request cache (`__ctxUse`, shared with the engine's ctx-shaped
 *    world fns in concurrent.ts), and the key serialization;
 *  - the settle TAP seam (`__setSettleTap`): the concurrent engine's hook
 *    into thenable settlement, consulted by the per-thenable shared
 *    listener at fire time.
 *
 * Everything here is COLD by design: reads route on the kernel's HAS_BOX
 * flag (never `instanceof` on a hot path), and a computed that never throws
 * or suspends never calls into this module.
 */

import { E, NodeField, NodeFlag, RecordGeom, batchDepth, activeSub, engineEpoch, flush, maybeBoundary, values } from './graph.js';
import type { NodeFlags, NodeId, ValueIndex } from './graph.js';

/**
 * Thrown when a read observes a pending suspension: by `ctx.use` inside a
 * computed evaluation, and by read sites whose computed's cached result is a
 * suspended box. Carries the pending thenable. (The React bindings
 * (`cosignals-react`) catch it at render read sites and forward it to
 * Suspense.)
 */
export class SuspendedRead {
	readonly thenable: PromiseLike<unknown>;
	constructor(thenable: PromiseLike<unknown>) {
		this.thenable = thenable;
	}
}

// Exceptional-outcome detection never uses `instanceof` on a hot path
// (measured ~9ns per `instanceof` there — 2.4× on read-heavy workloads).
// Reads route on the kernel's HAS_BOX flag; the policy-side filters
// (ctx.previous, the isEqual wrapper) test the same flag bits, which the
// eval-start rewrite deliberately PRESERVES while the getter runs so the
// residual slot payload can be told apart from a plain previous value.

// ---- the computed evaluation policy --------------------------------------------

type InstrumentedThenable = PromiseLike<unknown> & {
	status?: 'pending' | 'fulfilled' | 'rejected';
	value?: unknown;
	reason?: unknown;
	/** The thenable's stable SuspendedRead, created lazily at the first read
	 * that observes it pending — every read site throws THIS instance while
	 * the thenable is pending, so observers can dedupe by identity. */
	suspendSentinel?: SuspendedRead;
};

/**
 * ctx.previous (hoisted; called from POLICY_CTX). The evaluating node is the
 * kernel's activeSub; its value slot still holds the previous cached value
 * during the evaluation (updateComputed assigns after the getter returns),
 * and the eval-start rewrite preserved the exceptional bits, so one flag
 * test filters both "not a computed" and "residual error/thenable payload"
 * (which reads as undefined). Leaked-ctx calls outside a computed evaluation
 * fall under `previous`'s license to be arbitrarily stale or undefined.
 */
export function ctxPrevious(): unknown {
	const c = activeSub;
	if (c === 0) {
		return undefined;
	}
	if ((E.buffer()[c + NodeField.FLAGS]! & (NodeFlag.K_COMPUTED | NodeFlag.HAS_BOX)) !== NodeFlag.K_COMPUTED) {
		return undefined;
	}
	return values[c >> RecordGeom.ID_TO_VALUE_SHIFT];
}

/**
 * The canonical thenable protocol (mirrors React's trackUsedThenable):
 * instrument `status`/`value`/`reason` onto the thenable itself, once.
 * Settled thenables synchronously return their value / throw their reason;
 * pending ones throw the thenable's stable SuspendedRead (a lazy expando on
 * the thenable, so every read site and every re-evaluation observes ONE
 * "still pending" identity per thenable).
 */
function unwrapThenable(t: InstrumentedThenable): unknown {
	switch (t.status) {
		case 'fulfilled':
			return t.value;
		case 'rejected':
			throw t.reason;
		case 'pending':
			throw (t.suspendSentinel ??= new SuspendedRead(t));
		default: {
			t.status = 'pending';
			t.then(
				(v: unknown) => {
					if (t.status === 'pending') {
						t.status = 'fulfilled';
						t.value = v;
						// Settle tap: consulted at FIRE time, never captured at
						// instrument time — a thenable instrumented under an
						// earlier engine composition still notifies the current
						// one (test resets re-compose the engine).
						const tap = settleTap;
						if (tap !== undefined) tap(t);
					}
				},
				(e: unknown) => {
					if (t.status === 'pending') {
						t.status = 'rejected';
						t.reason = e;
						const tap = settleTap;
						if (tap !== undefined) tap(t);
					}
				},
			);
			throw (t.suspendSentinel ??= new SuspendedRead(t));
		}
	}
}

/**
 * The concurrent engine's settle tap. The kernel's per-thenable shared
 * listener — the pair `unwrapThenable` installs exactly once per thenable —
 * calls it after the status write, so world-only suspensions (arena-cached
 * sentinels the kernel never cached) are notified AT the settlement event
 * itself. ONE closure per engine composition; distinct-thenable dedup IS
 * the instrument-once discipline. The kernel-cached path (`attachSettle` →
 * stale-guarded `invalidateComputed`) is untouched and keeps handling
 * KERNEL suspensions precisely.
 */
let settleTap: ((t: PromiseLike<unknown>) => void) | undefined;

/** Installs/clears the settle tap (engine seam, set at composition). @internal */
export function __setSettleTap(fn: ((t: PromiseLike<unknown>) => void) | undefined): void {
	settleTap = fn;
}

/**
 * Stable serialization of a `ctx.use` key. Scalars serialize with a type
 * discriminant (strings JSON-escape, so `1`, `'1'`, `true`, `'true'`, `null`,
 * `'null'`, `NaN` all stay distinct); arrays serialize recursively. Anything
 * else — functions, objects, undefined, symbols — is rejected loudly.
 */
function serializeUseKey(key: unknown): string {
	if (typeof key === 'string') {
		return JSON.stringify(key);
	}
	if (typeof key === 'number' || typeof key === 'boolean' || key === null) {
		return String(key);
	}
	if (Array.isArray(key)) {
		let out = '[';
		for (let i = 0; i < key.length; i++) {
			if (i !== 0) {
				out += ',';
			}
			out += serializeUseKey(key[i]);
		}
		return out + ']';
	}
	throw new Error(
		'cosignals: ctx.use keys must be strings, numbers, booleans, null, or arrays of those — '
			+ `got ${typeof key}. Put the serializable inputs in the key and close over the rest in the factory.`,
	);
}

/**
 * THE ctx.use REQUEST-CACHE COLUMN — id-keyed engine state. The owning
 * `Computed` INSTANCE is stored nowhere kernel-side, so nothing here pins
 * the handle and a dropped handle's record can still reclaim. Keyed by
 * NODE INDEX (the recycled dense key): the record-free scrub clears the
 * freed record's entry (`__clearUseCacheForIndex`), so a slot's next
 * tenant can never be served the previous tenant's requests. A Map (not a
 * dense array) deliberately — ctx.use is a cold path and the map's delete
 * IS the scrub.
 */
const useCaches = new Map<number, Map<string, PromiseLike<unknown>>>();

/** The record-free scrub's suspense half (called by the engine's record-free
 * hook): drop the freed record's request cache. @internal */
export function __clearUseCacheForIndex(nodeIndex: number): void {
	useCaches.delete(nodeIndex);
}

/** Test-only (`__resetEngineForTest`): every request cache drops. @internal */
export function __resetSuspenseForTest(): void {
	useCaches.clear();
}

/** Test seam: a record's ctx.use request cache, by node index (the leak
 * audit probes clearing at record free). @internal */
export function __useCacheForTest(nodeIndex: number): Map<string, PromiseLike<unknown>> | undefined {
	return useCaches.get(nodeIndex);
}

/**
 * The two-form ctx.use dispatch over a node-index-keyed request cache — the
 * ONE suspense implementation, shared with the engine's ctx-shaped world
 * fns (which pass their node's index). See ComputedCtx.use for the
 * contract. The keyed cache is monotone per node: same key ⇒ same thenable
 * for the node's lifetime — including across worlds, which is safe exactly
 * because the key carries the world-varying inputs (a request cache never
 * un-learns an answer; a world that asks a different question uses a
 * different key). Entries evaporate at the record's free (the scrub above).
 * @internal — engine seam, not public API.
 */
export function __ctxUse(
	nodeIndex: number,
	sourceOrKey: unknown,
	factory: (() => PromiseLike<unknown>) | undefined,
): unknown {
	if (factory === undefined) {
		const t = sourceOrKey as InstrumentedThenable;
		if (t === null || (typeof t !== 'object' && typeof t !== 'function') || typeof t.then !== 'function') {
			throw new Error(
				typeof sourceOrKey === 'function'
					? 'cosignals: the bare factory form ctx.use(fn) was removed — pass ctx.use(key, factory) so the request is cached per key, or cache the promise yourself and pass ctx.use(promise).'
					: 'cosignals: ctx.use takes a thenable, or (key, factory).',
			);
		}
		return unwrapThenable(t);
	}
	if (typeof factory !== 'function') {
		throw new Error('cosignals: ctx.use(key, factory) requires a factory function.');
	}
	const k = serializeUseKey(sourceOrKey);
	let cache = useCaches.get(nodeIndex);
	if (cache === undefined) {
		cache = new Map();
		useCaches.set(nodeIndex, cache);
	}
	let t = cache.get(k) as InstrumentedThenable | undefined;
	if (t === undefined) {
		t = factory() as InstrumentedThenable;
		if (t === null || (typeof t !== 'object' && typeof t !== 'function') || typeof t.then !== 'function') {
			throw new Error('cosignals: the ctx.use factory must return a thenable.');
		}
		cache.set(k, t);
	}
	return unwrapThenable(t);
}

/**
 * ctx.use (hoisted; called from POLICY_CTX): resolve the evaluating
 * COMPUTED RECORD from the kernel's `activeSub` — id-keyed, no instance
 * lookup (the old aux-slot owner backref died at the merge; nothing pins
 * the handle) — and dispatch on its node index. The per-key cache lives
 * with the record and dies at its free — a recreated node refetches, which
 * is React's own uncached-promise story; callers needing cross-death dedup
 * cache the promise in their data layer and use the one-arg form.
 */
export function ctxUse(sourceOrKey: unknown, factory: (() => PromiseLike<unknown>) | undefined): unknown {
	const c = activeSub;
	if (c === 0 || (E.buffer()[c + NodeField.FLAGS]! & NodeFlag.K_COMPUTED) === 0) {
		throw new Error('cosignals: ctx.use may only be called during a computed evaluation.');
	}
	return __ctxUse(E.buffer()[c + NodeField.NODE_INDEX]!, sourceOrKey, factory);
}

/**
 * The kernel's exception hook (D3), cold: stores whatever a computed
 * evaluation threw as the RAW cached payload — the thrown value for an
 * error, the pending thenable for a suspension — and returns the exceptional
 * flag bits for the outcome. The caller folds the bits into the node's flags
 * and into its change cutoff: same payload + same bits ⇒ no change; any
 * delta ⇒ propagate. The settle listener is attached only on TRANSITION
 * (the previous outcome was not a suspension, or suspended on a different
 * thenable), so re-suspending on the same pending thenable stays
 * listener-stable.
 */
export function storeThrown(c: NodeId, e: unknown, oldValue: unknown, oldExc: NodeFlags): NodeFlags {
	const v: ValueIndex = c >> RecordGeom.ID_TO_VALUE_SHIFT;
	if (e instanceof SuspendedRead) {
		const t = e.thenable as InstrumentedThenable;
		values[v] = t;
		if ((oldExc & NodeFlag.BOX_SUSPENDED) === 0 || oldValue !== t) {
			attachSettle(c, t);
		}
		return NodeFlag.HAS_BOX | NodeFlag.BOX_SUSPENDED;
	}
	values[v] = e;
	return NodeFlag.HAS_BOX;
}

/**
 * Settlement-invalidate: when the pending thenable of a suspended computed
 * settles, mark the computed stale and propagate so watchers re-run and
 * readers recompute. Stale-guarded — the node must still cache THIS thenable
 * as a suspension (suspended bit set AND the slot holds `t`) — so
 * out-of-order settlement of superseded work is inert.
 */
function attachSettle(c: NodeId, t: InstrumentedThenable): void {
	// ENGINE-EPOCH GUARD (cross-reset microtask discipline): the listener
	// captures the epoch at attach; a settlement delivered after
	// `__resetEngineForTest` must not touch the scrubbed arena (the record
	// id may already belong to a new tenant). Belt and suspenders: the
	// stale-guard below is ALSO inert post-reset — the scrubbed record's
	// flags read 0 and the values column no longer holds the thenable.
	const epoch = engineEpoch;
	const onSettle = (): void => {
		if (epoch !== engineEpoch) {
			return; // a dead test's settlement — the engine it targeted is gone
		}
		if (
			(E.buffer()[c + NodeField.FLAGS]! & NodeFlag.BOX_SUSPENDED) === 0
			|| values[c >> RecordGeom.ID_TO_VALUE_SHIFT] !== t
		) {
			return;
		}
		try {
			maybeBoundary();
			E.invalidateComputed(c);
			if (batchDepth === 0) {
				flush();
			}
		} catch (err) {
			// Effects that throw during the settle flush surface like any other
			// unhandled error rather than rejecting the settled promise chain.
			// Epoch-guarded like every cross-reset microtask: a reset between
			// the throw and the rethrow swallows it (the erroring test is
			// already over; rethrowing into the next test would misattribute).
			queueMicrotask(() => {
				if (epoch !== engineEpoch) return;
				throw err;
			});
		}
	};
	t.then(onSettle, onSettle);
}

/**
 * Cold read tail (hoisted; called from the kernel's computedRead when the
 * HAS_BOX flag is set): the cached value is a raw exceptional payload.
 * Errors rethrow the payload directly. Suspensions whose thenable already
 * settled self-heal (invalidate + recompute) so a read after `await` is
 * deterministic even before the settle listener's microtask runs; pending
 * suspensions throw the thenable's stable SuspendedRead (created lazily on
 * it). The self-heal re-read recurses through the kernel tail at most once
 * more: a payload stored during the recursion necessarily carries a thenable
 * that was pending at creation, which throws — settlement cannot occur inside
 * this synchronous frame.
 */
export function boxedRead(c: NodeId, flags: NodeFlags): unknown {
	const v: ValueIndex = c >> RecordGeom.ID_TO_VALUE_SHIFT;
	if ((flags & NodeFlag.BOX_SUSPENDED) === 0) {
		throw values[v];
	}
	const t = values[v] as InstrumentedThenable;
	if (t.status === undefined || t.status === 'pending') {
		throw (t.suspendSentinel ??= new SuspendedRead(t));
	}
	E.invalidateComputed(c);
	const next = E.computedRead(c);
	if (batchDepth === 0) {
		flush();
	}
	return next;
}
