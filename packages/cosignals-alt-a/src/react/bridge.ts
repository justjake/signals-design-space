/**
 * The REAL-React bridge: adapts the patched React build's external-runtime
 * protocol (the "v2" surface that actually ships in vendor/react — see the
 * mapping below) onto this engine's existing §6 ForkAdapter interface. The
 * fork test double keeps serving the unit suites; this bridge is what a real
 * app (and the seam benchmark) attaches.
 *
 * Protocol mapping (real fork → spec §6, gaps documented):
 *
 *  real surface                              → §6 event this engine speaks
 *  ------------------------------------------------------------------------
 *  unstable_registerBatchIdAllocator(cb)     → token minting is OURS: React
 *    asks the bridge for an id at every batch's creation, with the deferred
 *    classification; we mint the spec §6.2 encoding `(serial<<1)|deferred`,
 *    so the engine's slot interning works unchanged. No mapping tables.
 *  (shared internals `T` slot)               → isCurrentWriteDeferred: the
 *    engine calls this probe on ambient reads under its guard that a read
 *    must never create a batch identity, so it must not touch
 *    unstable_getCurrentWriteBatch — the first such call in an event
 *    CREATES the batch. Reading the reconciler's current-transition slot
 *    classifies with no side effects (non-null, non-gesture scope ⇒ a
 *    write issued now is deferred), mirroring the classifier's own
 *    transition arm.
 *  (none)                                    → onRootRegistered: the real
 *    fork has no root-registration edge; the bridge synthesizes activation
 *    at attach time. Sound for variant A: attach precedes any React work,
 *    so flipping the monotonic write gate EARLIER than §9.1's edge only
 *    widens the always-log window (never narrows it).
 *  onRenderPassStart(container, included)    → same (lineage constant 0).
 *    The real fork carries no render lineage (§6.3) and none is needed: the
 *    Solid-adapted async model keys thenable identity on node×world (pass
 *    worlds key on their include MASK — stable across restarts and Suspense
 *    retries of one logical work, distinct for interleaved works whose
 *    batch sets differ).
 *  onRenderPassYield/Resume(container)       → identical.
 *  onRenderPassEnd(container, committed)     → onRenderPassEnd(container);
 *    the commit/discard bit is not needed by this engine's pass handling
 *    (sweep runs either way; per-root committed truth rides the commit
 *    report below).
 *  onRootCommitted(container, batches, gen)  → onBatchCommitted(container,
 *    batch) per reported batch (the engine's per-root committed views treat
 *    re-reports as idempotent lock-in adds).
 *  onBatchRetired(id, committed)             → identical.
 *  unstable_getCurrentWriteBatch()           → getCurrentWriteBatch();
 *    BATCH_NONE (0) reaches the engine's pseudo-batch degradation
 *    (applied + retired-at-append) — by protocol it is unreachable once a
 *    renderer registered its provider.
 *  unstable_runInBatch(id, fn)               → runInBatch; the real fork
 *    handles retired/unknown ids ITSELF (documented discrete-urgent
 *    fallback), so the adapter always reports true and the engine's own
 *    fallback branch becomes unreachable.
 *  unstable_getRenderContext()               → null → undefined.
 *
 *  Async actions: the fork keeps a transition batch pending across an async
 *  action and reports retirement at settlement; the bridge simply follows
 *  the retirement report (no engine-side parking). Post-await writes
 *  classify at their own moment — urgent unless re-wrapped — matching
 *  React's own transition rule.
 */
import * as React from 'react';
import type { CosignalEngine, Container } from '../engine';
import type { ExternalRuntimeListener, ForkAdapter } from '../fork-double';

/** The patched build's protocol exports (feature-detected, §6.7 skew rule). */
type ForkReact = {
	unstable_subscribeToExternalRuntime(listener: {
		onRenderPassStart?: (container: unknown, includedBatches: readonly number[]) => void;
		onRenderPassYield?: (container: unknown) => void;
		onRenderPassResume?: (container: unknown) => void;
		onRenderPassEnd?: (container: unknown, committed: boolean) => void;
		onBatchRetired?: (batchId: number, committed: boolean) => void;
		onRootCommitted?: (container: unknown, committedBatches: readonly number[], generation: number) => void;
	}): () => void;
	unstable_registerBatchIdAllocator(allocate: (deferred: boolean) => number): () => void;
	unstable_getCurrentWriteBatch(): number;
	unstable_getRenderContext(): { container: unknown } | null;
	unstable_runInBatch(batchId: number, fn: () => void): unknown;
	unstable_resetBatchRegistryForTest?: () => void;
};

/** The reconciler's current-transition scope object (its `gesture` field
 * marks gesture transitions, which classify urgent), read through React's
 * shared-internals export — the one write-classification fact observable
 * without creating a batch identity. */
function currentTransitionScope(react: unknown): { gesture?: unknown } | null | undefined {
	return (
		react as {
			__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
				T?: { gesture?: unknown } | null;
			};
		}
	).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.T;
}

export function assertForkPresent(react: unknown = React): asserts react is ForkReact {
	const r = react as Partial<ForkReact>;
	if (
		typeof r.unstable_subscribeToExternalRuntime !== 'function'
		|| typeof r.unstable_registerBatchIdAllocator !== 'function'
	) {
		throw new Error(
			'cosignals-alt-a/react: this React build has no external-runtime protocol — '
			+ 'a patched React (vendor/react build, pnpm overrides) is required; stock React has none. '
			+ 'Building a silent degraded mode is out of scope: parity is the product (§6.7).',
		);
	}
}

export type ReactBridgeHandle = {
	engine: CosignalEngine;
	/** Errors thrown by engine listeners, captured (never thrown into React's
	 * commit — §6.7 listener-error rule). */
	readonly errors: unknown[];
	dispose(): void;
};

/**
 * Couples the engine to the loaded patched React. Call after importing
 * react-dom/client (the renderer registers its protocol provider at module
 * load), before creating any root. One bridge per engine composition.
 */
export function attachReactBridge(engine: CosignalEngine, react: unknown = React): ReactBridgeHandle {
	assertForkPresent(react);
	const R = react;
	const errors: unknown[] = [];
	let serial = 0;
	let unsubscribeReact: (() => void) | undefined;
	// The engine assumes one open pass at a time (§6.3). The real work loop
	// guarantees it, but be defensive: close a stale pass before opening the
	// next (the same defined fall-through cosignals' shim takes).
	let openContainer: unknown;
	let passOpen = false;

	const adapter: ForkAdapter = {
		subscribeToExternalRuntime(listener: ExternalRuntimeListener): () => void {
			const guard = (fn: () => void): void => {
				try {
					fn();
				} catch (err) {
					errors.push(err);
				}
			};
			// Synthesized activation edge (§9.1): attach precedes all React work.
			guard(() => listener.onRootRegistered?.('react-bridge'));
			unsubscribeReact = R.unstable_subscribeToExternalRuntime({
				onRenderPassStart: (container, included) =>
					guard(() => {
						if (passOpen) {
							listener.onRenderPassEnd?.(openContainer);
						}
						passOpen = true;
						openContainer = container;
						// No lineage: the Solid-adapted async model keys thenable
						// identity on node×world (pass include-mask), so render-
						// attempt identity is not needed (the old synthesized
						// per-container lineage — and its aliasing limitation —
						// are deleted).
						listener.onRenderPassStart?.(container, included, 0);
					}),
				onRenderPassYield: (container) => guard(() => listener.onRenderPassYield?.(container)),
				onRenderPassResume: (container) => guard(() => listener.onRenderPassResume?.(container)),
				onRenderPassEnd: (container, _committed) =>
					guard(() => {
						passOpen = false;
						listener.onRenderPassEnd?.(container);
					}),
				onBatchRetired: (batchId, committed) => guard(() => listener.onBatchRetired?.(batchId, committed)),
				onRootCommitted: (container, committedBatches) =>
					guard(() => {
						for (const b of committedBatches) {
							listener.onBatchCommitted?.(container, b);
						}
					}),
			});
			return () => unsubscribeReact?.();
		},
		isCurrentWriteDeferred(): boolean {
			// Side-effect-free probe (see the header's `T`-slot mapping row):
			// reads must never create a batch identity, and the first
			// unstable_getCurrentWriteBatch call in an event does exactly that.
			const t = currentTransitionScope(R);
			return t !== null && t !== undefined && !t.gesture;
		},
		getCurrentWriteBatch(): number {
			return R.unstable_getCurrentWriteBatch();
		},
		getRenderContext(): { container: Container } | undefined {
			return R.unstable_getRenderContext() ?? undefined;
		},
		runInBatch(token: number, fn: () => void): boolean {
			// The real fork owns the retired-token fallback (discrete-urgent).
			R.unstable_runInBatch(token, fn);
			return true;
		},
	};

	// Token minting is ours: React stores the returned id as the batch's
	// identity for its whole life, so every protocol surface speaks the
	// engine's own §6.2-encoded tokens with no translation anywhere.
	const unregisterAllocator = R.unstable_registerBatchIdAllocator(
		(deferred: boolean) => ((++serial << 1) | (deferred ? 1 : 0)) | 0,
	);
	const detachEngine = engine.attachFork(adapter);

	return {
		engine,
		errors,
		dispose(): void {
			detachEngine();
			unregisterAllocator();
			R.unstable_resetBatchRegistryForTest?.();
		},
	};
}
