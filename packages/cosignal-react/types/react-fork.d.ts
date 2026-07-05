/**
 * Ambient declarations for the cosignal React fork's protocol surface
 * (vendor/react @ 56178d8c13, fork/S4-REPORT.md "Handoff notes" item 1).
 * The linked build ships no types; @types/react covers the stock surface and
 * this file augments the unstable_* protocol entries the bindings consume.
 */
declare module 'react' {
	export interface ExternalRuntimeListener {
		/** Pass frame opened. `includedBatches` = live batch tokens this pass renders; `lineageId` stable per (root x batch-set). */
		onRenderPassStart?: (container: unknown, includedBatches: readonly number[], lineageId: number) => void;
		onRenderPassYield?: (container: unknown) => void;
		onRenderPassResume?: (container: unknown) => void;
		/** Frame closed exactly once; committed=true fires inside the commit, BEFORE onRootCommitted (baseline capture site). */
		onRenderPassEnd?: (container: unknown, committed: boolean) => void;
		onBeforeMutation?: (container: unknown) => void;
		onAfterMutation?: (container: unknown) => void;
		/** Exactly once per token; committed=false only for batches that produced no React work. */
		onBatchRetired?: (token: number, committed: boolean) => void;
		/** Every commit of a root, in order; `committedBatches` = the delta added to the root's committed-batch table. */
		onRootCommitted?: (
			container: unknown,
			committedBatches: readonly number[],
			rootCommitGeneration: number,
		) => void;
	}

	export function unstable_subscribeToExternalRuntime(listener: ExternalRuntimeListener): () => void;
	/** 0 = none; bit 0 = deferred (transition-like); token stable for the batch's life. */
	export function unstable_getCurrentWriteBatch(): number;
	export function unstable_isCurrentWriteDeferred(): boolean;
	export function unstable_getRenderContext(): null | { container: unknown };
	/** Runs fn so updates it schedules join the token's batch; retired/unknown/0 = discrete-urgent fallback. Throws (605) during render. */
	export function unstable_runInBatch<R>(token: number, fn: () => R): R;
	/** Synchronously abandons every WIP pass on every root. */
	export function unstable_discardAllWip(): void;
	export const unstable_externalRuntimeProtocol: {
		version: number;
		capabilities: number;
		providerProtocols: Array<{ version: number; capabilities: number }>;
	};
}

export {};
