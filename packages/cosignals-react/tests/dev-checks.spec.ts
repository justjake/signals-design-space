import { afterEach, describe, expect, test } from 'vitest';
import 'react-dom/client';
import { __TEST__resetEngine } from 'cosignals';
import { registerCosignalReact, type CosignalReactHandle } from '../src/index.js';

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
