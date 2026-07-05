/**
 * Ambient declarations for the cosignal external-runtime protocol, version
 * 1 — the surface a patched React build exposes so an external store can
 * stay correct under concurrent rendering (stock React never reveals when
 * it starts, pauses, commits, or discards a render pass). The patched build
 * ships no type declarations of its own; @types/react covers the stock
 * surface, and this file augments the unstable_* protocol entries these
 * bindings consume.
 */
declare module 'react' {
	export interface ExternalRuntimeListener {
		/** A render pass opened on a root. `includedBatches` = the live batch tokens this pass renders; `lineageId` is stable per (root × included-batch set), so a restarted pass over the same batches keeps its lineage. */
		onRenderPassStart?: (container: unknown, includedBatches: readonly number[], lineageId: number) => void;
		onRenderPassYield?: (container: unknown) => void;
		onRenderPassResume?: (container: unknown) => void;
		/** The pass frame closed, exactly once per open; committed=true fires inside the commit, BEFORE the same commit's onRootCommitted — the point where an external store can still snapshot committed state as a baseline. */
		onRenderPassEnd?: (container: unknown, committed: boolean) => void;
		onBeforeMutation?: (container: unknown) => void;
		onAfterMutation?: (container: unknown) => void;
		/** The batch is done everywhere; fires exactly once per token. committed=false only for batches that produced no React work. */
		onBatchRetired?: (token: number, committed: boolean) => void;
		/** Every commit of a root, in order; `committedBatches` = the delta this commit added to the root's committed-batch table (one batch's work can reach the screen across several flushes). */
		onRootCommitted?: (
			container: unknown,
			committedBatches: readonly number[],
			rootCommitGeneration: number,
		) => void;
	}

	/** Subscribes an external store to the protocol events; returns the unsubscribe function. */
	export function unstable_subscribeToExternalRuntime(listener: ExternalRuntimeListener): () => void;
	/** The write-context API: which batch is the current code executing on behalf of? 0 = none; bit 0 set = deferred (a transition or other non-urgent batch); a token is stable for its batch's whole life. */
	export function unstable_getCurrentWriteBatch(): number;
	/** True when the current write context is deferred (non-urgent). */
	export function unstable_isCurrentWriteDeferred(): boolean;
	/** The root container currently rendering on this call stack, or null outside render. */
	export function unstable_getRenderContext(): null | { container: unknown };
	/** Runs fn so the state updates it schedules join the token's batch, rendering and committing with it; a retired, unknown, or 0 token takes a discrete-urgent fallback instead. Throws if called during render (React error 605) — update attribution during a render pass belongs to the pass itself. */
	export function unstable_runInBatch<R>(token: number, fn: () => R): R;
	/** Synchronously abandons every in-progress render pass on every root. */
	export function unstable_discardAllWip(): void;
	/** The handshake object: protocol version, capability bits, and one entry per renderer that registered a provider. */
	export const unstable_externalRuntimeProtocol: {
		version: number;
		capabilities: number;
		providerProtocols: Array<{ version: number; capabilities: number }>;
	};
}

export {};
