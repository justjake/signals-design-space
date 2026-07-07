/**
 * devChecks — the protocol-edge fail-fast switch (BridgeOptions.devChecks).
 *
 * This file NEVER imports react-dom, on purpose: the external-runtime
 * provider registers when a renderer module loads, so here
 * unstable_getCurrentWriteBatch() returns the real token 0 ("no renderer
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
	handlePassStart(container: unknown, includedBatches: readonly number[]): void;
	handlePassEnd(container: unknown, committed: boolean): void;
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

describe('write classifier: no batch context (token 0)', () => {
	test('armed: a context-free write throws a protocol violation, and no state moves', () => {
		const h = register(true);
		const a = new Atom(0);
		expect(() => a.set(5)).toThrow(/protocol violation — signal write with no batch context/);
		expect(a.state).toBe(0); // the classifier threw before any write landed
		expect(h.bridge.liveTokens()).toHaveLength(0); // no token minted
		expect(h.bridge.ambientToken).toBeUndefined(); // and never an ambient batch
	});

	test('off: a context-free write classifies as an ordinary urgent write (no ambient batch, no fallback arm)', () => {
		const h = register(false);
		const a = new Atom(0);
		const b = new Atom(0);
		a.set(5);
		expect(a.state).toBe(5); // newest world: the write landed
		// One ordinary batch token — NOT the engine's ambient default batch,
		// not parked: token 0's low bit is clear, so the write is urgent.
		expect(h.bridge.ambientToken).toBeUndefined();
		const live = h.bridge.liveTokens();
		expect(live).toHaveLength(1);
		expect(live[0]!.ambient).toBe(false);
		expect(live[0]!.parked).toBe(false);
		// Later context-free writes reuse the same bridge token (one fork
		// token, one bridge token — the ordinary classifier rule).
		b.set(7);
		expect(b.state).toBe(7);
		expect(h.bridge.liveTokens()).toHaveLength(1);
	});
});

describe('startSignalTransition: no batch context (token 0)', () => {
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
		// No parked action token was minted for token 0 — nothing could ever
		// settle it; the write rode the ordinary token-0 batch instead.
		expect(h.bridge.liveTokens().some((t) => t.parked)).toBe(false);
		expect(h.bridge.liveTokens()).toHaveLength(1);
	});
});

describe('pass start over a still-open pass', () => {
	test('armed: the second pass start throws a protocol violation', () => {
		const h = register(true);
		const shim = h.shim as unknown as ShimListeners;
		const container = {};
		shim.handlePassStart(container, []);
		expect([...h.bridge.passes.values()].filter((p) => p.state !== 'ended')).toHaveLength(1);
		expect(() => shim.handlePassStart(container, [])).toThrow(/protocol violation — render pass started .* still open/);
		shim.handlePassEnd(container, false); // close the frame so the bridge quiesces
	});

	test('off: the stale pass is discarded silently (no error log) and the new pass opens', () => {
		const h = register(false);
		const shim = h.shim as unknown as ShimListeners;
		const container = {};
		shim.handlePassStart(container, []);
		const first = [...h.bridge.passes.values()].find((p) => p.state !== 'ended')!;
		shim.handlePassStart(container, []); // desync repair: discard, then start fresh
		expect(h.shim.errors).toHaveLength(0); // the old loud error log is gone
		expect(first.state).toBe('ended'); // the stale pass was discarded (it can never double-account)
		const open = [...h.bridge.passes.values()].filter((p) => p.state !== 'ended');
		expect(open).toHaveLength(1); // exactly the fresh pass remains
		expect(open[0]!.id).not.toBe(first.id);
		shim.handlePassEnd(container, false);
	});
});
