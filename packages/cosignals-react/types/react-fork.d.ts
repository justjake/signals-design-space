/**
 * Ambient declarations for the cosignals external-runtime protocol, version
 * 2 — the surface a patched React build exposes so an external store can
 * stay correct under concurrent rendering (stock React never reveals when
 * it starts, pauses, commits, or discards a render pass). The patched build
 * ships no type declarations of its own; @types/react covers the stock
 * surface, and this file augments the unstable_* protocol entries these
 * bindings consume.
 *
 * Batch identity (v2): batches cross this surface as positive integer batch
 * ids, allocated by the external store itself when it registers a batch-id
 * allocator (unstable_registerBatchIdAllocator) — React calls the allocator
 * once per batch, at the batch's creation, and stores the returned id as
 * the batch's identity for its whole life. Store ids and React ids are ONE
 * number space: no translation tables on either side. 0 is the reserved
 * "no batch" id (cosignals names it BATCH_NONE on both sides). The id
 * carries no payload — whether a batch is DEFERRED (transition-like:
 * renders don't block paint and the batch commits later) is told to the
 * allocator at creation, not encoded in the id. Without a registered
 * allocator React numbers batches from an internal counter; the protocol
 * is otherwise identical.
 */
declare module 'react' {
	export interface ExternalRuntimeListener {
		/** A render pass opened on a root. `includedBatches` = the ids of every live batch this pass renders. */
		onRenderPassStart?: (container: unknown, includedBatches: readonly number[]) => void;
		onRenderPassYield?: (container: unknown) => void;
		onRenderPassResume?: (container: unknown) => void;
		/** The pass frame closed, exactly once per open; committed=true fires inside the commit, BEFORE the same commit's onRootCommitted — the point where an external store can still snapshot committed state as a baseline. */
		onRenderPassEnd?: (container: unknown, committed: boolean) => void;
		/** Part of the host protocol (fires just before a commit starts mutating the host tree); planned — not yet wired by these bindings. */
		onBeforeMutation?: (container: unknown) => void;
		/** Part of the host protocol (fires once a commit is done mutating the host tree); planned — not yet wired by these bindings. */
		onAfterMutation?: (container: unknown) => void;
		/** The batch is done everywhere; fires exactly once per batch id. committed=false only for batches that produced no React work. */
		onBatchRetired?: (batchId: number, committed: boolean) => void;
		/** Every commit of a root, in order; `committedBatches` = the delta this commit added to the root's committed-batch table (one batch's work can reach the screen across several flushes). */
		onRootCommitted?: (
			container: unknown,
			committedBatches: readonly number[],
			rootCommitGeneration: number,
		) => void;
	}

	/** Subscribes an external store to the protocol events; returns the unsubscribe function. */
	export function unstable_subscribeToExternalRuntime(listener: ExternalRuntimeListener): () => void;
	/**
	 * Registers the external store's batch-id allocator; returns the
	 * unregister function. React calls the allocator exactly once per batch,
	 * at the batch's creation — the first time an external write asks for the
	 * current batch on a lane with no live batch — passing the batch's
	 * deferred classification (true = transition-like), which is also how the
	 * store learns each batch's deferredness. The allocator must return a
	 * positive integer no live batch currently carries; React stores it as
	 * the batch's identity everywhere (events, getCurrentWriteBatch,
	 * runInBatch). Creation can happen mid-render, mid-commit, or inside
	 * protocol listeners, so the allocator must only allocate and record —
	 * run nothing else. Throws if an allocator is already registered (ids are
	 * one number space; exactly one store can own allocation).
	 */
	export function unstable_registerBatchIdAllocator(allocateBatchId: (deferred: boolean) => number): () => void;
	/** The write-context API: the id of the batch the current code is executing on behalf of, stable for that batch's whole life (created through the registered allocator on first ask). 0 = no batch (no renderer provider registered — unreachable once a renderer has loaded). */
	export function unstable_getCurrentWriteBatch(): number;
	/** The root container currently rendering on this call stack, or null outside render. */
	export function unstable_getRenderContext(): null | { container: unknown };
	/** Runs fn so the state updates it schedules join the batch, rendering and committing with it; a retired, unknown, or 0 batch id takes a discrete-urgent fallback instead. Throws if called during render (React error 605) — update attribution during a render pass belongs to the pass itself. */
	export function unstable_runInBatch<R>(batchId: number, fn: () => R): R;
	/** Synchronously abandons every in-progress render pass on every root. */
	export function unstable_discardAllWip(): void;
	/**
	 * TEST-ONLY. Clears the batch registry's full slot tenancy — batch ids,
	 * deferred flags, pending-root sets, committed-root sets, parked async
	 * actions — without emitting retirement events (a scrub, not a batch
	 * outcome). Test harnesses call it between tests so a stale slot from one
	 * test can never merge with, or settle over, a batch of the next (test
	 * stores may restart their id space per test; a parked settlement firing
	 * late additionally no-ops via its captured batch id). Never call this in
	 * production: live batches lose their retirement edge.
	 */
	export function unstable_resetBatchRegistryForTest(): void;
}

export {};
