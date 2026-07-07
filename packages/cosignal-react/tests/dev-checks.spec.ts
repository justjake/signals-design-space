/**
 * devChecks — the protocol-edge fail-fast switch (BridgeOptions.devChecks).
 *
 * This file NEVER imports react-dom, on purpose: the external-runtime
 * provider registers when a renderer module loads, so here
 * unstable_getCurrentWriteBatch() returns the real React batch id 0 ("no renderer
 * provider registered") — the exact state the integration contract makes
 * unreachable in an app. That lets these tests drive every guarded site
 * genuinely, with no mocking:
 *
 *  - armed (devChecks: true — every other suite file, via makeHarness):
 *    protocol violations THROW at the violating call.
 *  - off (devChecks: false — the production default): each guarded site is
 *    one boolean branch into its defined fall-through, and the dev-warning
 *    heuristic never runs (see scenarios R12/R12b for the warning pins).
 */
import { afterEach, describe, expect, test } from 'vitest';
import { Atom, __newBridgeForTest } from 'cosignal';
import { registerCosignalReact, startSignalTransition, type CosignalReactHandle } from '../src/index.js';

/** The shim's protocol listeners, driven directly (TypeScript-private only;
 * the protocol host is what normally calls these). */
type ShimListeners = {
	handleRenderStart(container: unknown, includedBatches: readonly number[]): void;
	handleRenderEnd(container: unknown, committed: boolean): void;
};

let handle: CosignalReactHandle | undefined;

function register(devChecks: boolean): CosignalReactHandle {
	handle = registerCosignalReact({ bridge: __newBridgeForTest({ devChecks }) });
	return handle;
}

afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

describe('write classifier: no batch context (React batch id 0)', () => {
	test('armed: a context-free write throws a protocol violation, and no state moves', () => {
		const h = register(true);
		const a = new Atom(0);
		expect(() => a.set(5)).toThrow(/protocol violation — signal write with no batch context/);
		expect(a.state).toBe(0); // the classifier threw before any write landed
		expect(h.bridge.liveBatches()).toHaveLength(0); // no batch minted
		expect(h.bridge.ambientBatch).toBeUndefined(); // and never an ambient batch
	});

	test('off: a context-free write classifies as an ordinary urgent write (no ambient batch, no fallback arm)', () => {
		const h = register(false);
		const a = new Atom(0);
		const b = new Atom(0);
		a.set(5);
		expect(a.state).toBe(5); // newest world: the write landed
		// One ordinary batch — NOT the engine's ambient default batch,
		// not parked: React batch id 0's low bit is clear, so the write is urgent.
		expect(h.bridge.ambientBatch).toBeUndefined();
		const live = h.bridge.liveBatches();
		expect(live).toHaveLength(1);
		expect(live[0]!.ambient).toBe(false);
		expect(live[0]!.parked).toBe(false);
		// Later context-free writes reuse the same engine batch (one React
		// batch id, one engine batch — the ordinary classifier rule).
		b.set(7);
		expect(b.state).toBe(7);
		expect(h.bridge.liveBatches()).toHaveLength(1);
	});
});

describe('startSignalTransition: no batch context (React batch id 0)', () => {
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

	test('off: the action runs; with no batch to park, its writes classify as ordinary urgent writes', () => {
		const h = register(false);
		const a = new Atom(0);
		startSignalTransition(() => {
			a.set(3);
		});
		expect(a.state).toBe(3);
		// No parked action batch was minted for React batch id 0 — nothing could ever
		// settle it; the write rode the ordinary id-0 batch instead.
		expect(h.bridge.liveBatches().some((t) => t.parked)).toBe(false);
		expect(h.bridge.liveBatches()).toHaveLength(1);
	});
});

describe('render start over a still-open render', () => {
	test('armed: the second render start throws a protocol violation', () => {
		const h = register(true);
		const shim = h.shim as unknown as ShimListeners;
		const container = {};
		shim.handleRenderStart(container, []);
		expect([...h.bridge.idToRenderPass.values()].filter((p) => p.state !== 'ended')).toHaveLength(1);
		expect(() => shim.handleRenderStart(container, [])).toThrow(/protocol violation — render pass started .* still open/);
		shim.handleRenderEnd(container, false); // close the frame so the bridge quiesces
	});

	test('off: the stale render is discarded silently (no error log) and the new render opens', () => {
		const h = register(false);
		const shim = h.shim as unknown as ShimListeners;
		const container = {};
		shim.handleRenderStart(container, []);
		const first = [...h.bridge.idToRenderPass.values()].find((p) => p.state !== 'ended')!;
		shim.handleRenderStart(container, []); // desync repair: discard, then start fresh
		expect(h.shim.errors).toHaveLength(0); // the old loud error log is gone
		expect(first.state).toBe('ended'); // the stale render was discarded (it can never double-account)
		const open = [...h.bridge.idToRenderPass.values()].filter((p) => p.state !== 'ended');
		expect(open).toHaveLength(1); // exactly the fresh render remains
		expect(open[0]!.id).not.toBe(first.id);
		shim.handleRenderEnd(container, false);
	});
});
