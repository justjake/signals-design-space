/**
 * devChecks — the protocol-edge fail-fast switch (EngineResetOptions.devChecks:
 * a reset parameter of the ONE module-level engine).
 *
 * This file NEVER imports react-dom, on purpose: the external-runtime
 * provider registers when a renderer module loads, so here
 * getExternalRuntimeCurrentWriteBatch() returns the real BATCH_NONE (0, "no
 * renderer provider registered") — the exact state the integration contract
 * makes unreachable in an app. That lets these tests drive every guarded
 * site genuinely, with no mocking:
 *
 *  - armed (devChecks: true — every other suite file, via makeHarness):
 *    protocol violations THROW at the violating call.
 *  - off (devChecks: false — the production default): each guarded site is
 *    one boolean branch into its defined fall-through, and the dev-warning
 *    heuristic never runs (see scenarios R12/R12b for the warning pins).
 */
import { afterEach, describe, expect, test } from 'vitest';
import { Atom, __TEST__resetEngine } from 'cosignals';
import { registerCosignalReact, startSignalTransition, type CosignalReactHandle } from '../src/index.js';

/** The shim's protocol listeners, driven directly (TypeScript-private only;
 * the protocol host is what normally calls these). */
type ShimListeners = {
	handleRenderStart(container: unknown, includedBatches: readonly number[]): void;
	handleRenderEnd(container: unknown, committed: boolean): void;
};

let handle: CosignalReactHandle | undefined;

function register(devChecks: boolean): CosignalReactHandle {
	// The reset clears the previous test's driver slot (dispose never
	// detaches) and lands devChecks as a reset parameter; the fresh
	// registration then attaches this test's driver.
	__TEST__resetEngine({ devChecks });
	handle = registerCosignalReact();
	return handle;
}

afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

describe('write classifier: no batch context (BATCH_NONE)', () => {
	test('armed: a context-free write throws a protocol violation, and no state moves', () => {
		const h = register(true);
		const a = new Atom(0);
		expect(() => a.set(5)).toThrow(/protocol violation — signal write with no batch context/);
		expect(a.state).toBe(0); // the classifier threw before any write landed
		expect(h.engine.liveBatches()).toHaveLength(0); // no batch created
		expect(h.engine.ambientBatch).toBeUndefined(); // and never an ambient batch
	});

	test('off: a context-free write takes the engine no-context fall-through (quiet fold, no batch)', () => {
		const h = register(false);
		const a = new Atom(0);
		const b = new Atom(0);
		a.set(5);
		expect(a.state).toBe(5); // newest world: the write landed
		// Protocol v2 deleted the id-translation layer, and with it the v1
		// materialization of "React batch id 0" as its own mapped engine
		// batch. BATCH_NONE now means what it says — no batch context — so
		// the write takes the ENGINE's own no-context path: with nothing
		// pending the engine is QUIET and the write folds directly; no batch
		// of any kind materializes (ambient included).
		expect(h.engine.ambientBatch).toBeUndefined();
		expect(h.engine.liveBatches()).toHaveLength(0);
		// Later context-free writes fold the same way — still no batch.
		b.set(7);
		expect(b.state).toBe(7);
		expect(h.engine.liveBatches()).toHaveLength(0);
	});
});

describe('startSignalTransition: no batch context (BATCH_NONE)', () => {
	test('armed: throws to the caller, before React.startTransition swallows scope errors', () => {
		register(true);
		let ran = false;
		expect(() =>
			startSignalTransition(() => {
				ran = true;
			}),
		).toThrow(/no transition batch context/);
		expect(ran).toBe(false); // the action body never started
	});

	test('off: the action runs; with no batch to park, its writes take the no-context fall-through', () => {
		const h = register(false);
		const a = new Atom(0);
		startSignalTransition(() => {
			a.set(3);
		});
		expect(a.state).toBe(3);
		// No parked action batch was created for BATCH_NONE — nothing could
		// ever settle it; the write folded quietly (the engine's no-context
		// path), creating no batch at all.
		expect(h.engine.liveBatches().some((t) => t.parked)).toBe(false);
		expect(h.engine.liveBatches()).toHaveLength(0);
	});
});

describe('render start over a still-open render', () => {
	test('armed: the second render start throws a protocol violation', () => {
		const h = register(true);
		const shim = h.shim as unknown as ShimListeners;
		const container = {};
		shim.handleRenderStart(container, []);
		expect([...h.engine.idToRenderPass.values()].filter((p) => p.state !== 'ended')).toHaveLength(1);
		expect(() => shim.handleRenderStart(container, [])).toThrow(/protocol violation — render pass started .* still open/);
		shim.handleRenderEnd(container, false); // close the frame so the engine quiesces
	});

	test('off: the stale render is discarded silently (no error log) and the new render opens', () => {
		const h = register(false);
		const shim = h.shim as unknown as ShimListeners;
		const container = {};
		shim.handleRenderStart(container, []);
		const first = [...h.engine.idToRenderPass.values()].find((p) => p.state !== 'ended')!;
		shim.handleRenderStart(container, []); // desync repair: discard, then start fresh
		expect(h.shim.errors).toHaveLength(0); // the old loud error log is gone
		expect(first.state).toBe('ended'); // the stale render was discarded (it can never double-account)
		const open = [...h.engine.idToRenderPass.values()].filter((p) => p.state !== 'ended');
		expect(open).toHaveLength(1); // exactly the fresh render remains
		expect(open[0]!.id).not.toBe(first.id);
		shim.handleRenderEnd(container, false);
	});
});
