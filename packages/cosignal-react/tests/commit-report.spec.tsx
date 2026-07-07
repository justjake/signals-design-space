/**
 * The root-commit report's reconciliation path (W11).
 *
 * React's per-root commit report is a delta, and re-reporting a batch is
 * defined as an idempotent set-add. When the report names a live batch the
 * engine's render-end sweep did NOT lock in, the shim reconciles it — and that
 * reconciliation must be the engine's COMPLETE per-root commit transition
 * (committed-batch set, the committed bit mask the visibility check reads,
 * the commit generation, the committed-advance clock, arena fan-out, and the
 * watcher drain), not a partial one. The load-bearing consequence pinned
 * here: after the report is processed, committed-world reads for that root
 * INCLUDE the reported batch's writes.
 *
 * React never produces this shape on its own (for batches carrying bridge
 * batches, the committing render's own batch set covers the delta by
 * construction), so the report is injected directly into the shim's
 * `onRootCommitted` handler while a REAL transition batch is live and not
 * yet locked in.
 */
import { describe, expect, test, afterEach } from 'vitest';
import * as React from 'react';
import { Atom, type AtomNode } from 'cosignal';
import { useSignal } from '../src/index.js';
import { makeHarness, act, text, type Harness } from './helpers.js';

/** The shim internals this suite drives directly (private in production). */
type ShimInternals = {
	rootsByContainer: Map<unknown, { id: string }>;
	handleRootCommitted(container: unknown, committedBatches: readonly number[], generation: number): void;
};

let h: Harness;
afterEach(async () => {
	await h.cleanup();
});

describe('root-commit report reconciliation (W11)', () => {
	test("report names a live batch render-end didn't lock in — committed world includes its writes", async () => {
		h = makeHarness();
		const a = new Atom(0);
		function Reader() {
			return <span>v:{useSignal(a)};</span>;
		}
		const { container } = await h.mount(<Reader />);
		expect(text(container)).toBe('v:0;');

		const shim = h.handle.shim as unknown as ShimInternals;
		expect(shim.rootsByContainer.size).toBe(1);
		const [rootContainer, rec] = [...shim.rootsByContainer.entries()][0]!;
		const node = h.bridge.byKernelId.get(a._id) as AtomNode;

		await act(async () => {
			// A REAL protocol batch: the transition write classifies into it and
			// it stays live — no render has rendered or committed it yet, so
			// render-end has NOT locked it into the root's committed table.
			React.startTransition(() => a.set(7));
			const batch = h.bridge.liveBatches().find((t) => !t.ambient);
			expect(batch).toBeDefined();
			const tid = batch!.id;
			const reactBatchId = h.handle.shim.reactBatchForBatch(tid);
			expect(reactBatchId).toBeDefined();
			const root = h.bridge.root(rec.id);
			expect(root.committedBatches.has(tid)).toBe(false); // render-end never saw it
			const genBefore = root.commitGen;
			expect(h.bridge.committedValue(node, rec.id)).toBe(0); // still pending for this root

			// React's report names the live batch render-end didn't lock in.
			shim.handleRootCommitted(rootContainer, [reactBatchId!], 1);

			// The COMPLETE lock-in, not the half-job: committed-world reads for
			// this root now include the batch's writes...
			expect(h.bridge.committedValue(node, rec.id)).toBe(7);
			// ...because the committed-batch set and the bit mask the visibility
			// check reads moved TOGETHER, with the generation.
			expect(root.committedBatches.has(tid)).toBe(true);
			const slot = h.bridge.idToBatch.get(tid)!.slot;
			expect(slot).toBeDefined();
			expect((root.committedBits >>> slot!) & 1).toBe(1);
			expect(root.commitGen).toBe(genBefore + 1);

			// Re-reporting the same batch is an idempotent set-add: no-op.
			shim.handleRootCommitted(rootContainer, [reactBatchId!], 2);
			expect(root.commitGen).toBe(genBefore + 1);
			expect(h.bridge.committedValue(node, rec.id)).toBe(7);
		});

		// The act flush lets the transition render, commit, and retire through
		// the REAL protocol events: render-end's own sweep sees the batch already
		// committed (the other caller of the same idempotent operation), and the
		// screen settles on the batch's value.
		expect(text(container)).toBe('v:7;');
		expect(h.bridge.committedValue(node, rec.id)).toBe(7);
	});
});
