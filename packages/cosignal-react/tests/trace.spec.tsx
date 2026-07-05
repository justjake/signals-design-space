/**
 * Trace smoke (task 4d): attachTracer over the bridge, drive a real React
 * scenario through the bindings, and assert the semantic event classes appear
 * — proving the bindings route through the bridge (no bypass): writes, pass
 * lifecycle, per-root commits, deliveries, and the mount-fixup disposition.
 */
import { expect, test, afterEach } from 'vitest';
import * as React from 'react';
import { flushSync } from 'react-dom';
import { Atom } from 'cosignal/logged';
import { attachTracer } from 'cosignal/trace';
import { useSignal } from '../src/index.js';
import { makeHarness, act, text, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
	await h.cleanup();
});

function Reader({ id, atom }: { id: string; atom: Atom<number> }) {
	return (
		<span>
			{id}:{useSignal(atom)};
		</span>
	);
}

test('tracer observes writes, pass lifecycle, root commits, deliveries, and fixups', async () => {
	h = makeHarness();
	const tracer = attachTracer(h.bridge);
	const a = new Atom(0);
	function App({ extra }: { extra: boolean }) {
		return (
			<>
				<Reader id="r1" atom={a} />
				{extra ? <Reader id="r2" atom={a} /> : null}
			</>
		);
	}
	const { root, container } = await h.mount(<App extra={false} />);
	await act(async () => {
		a.set(1); // urgent write + delivery
	});
	await act(async () => {
		React.startTransition(() => a.set(2)); // deferred batch
		flushSync(() => root.render(<App extra />)); // late mount: fixup + corrective
	});
	await act(async () => {});
	expect(text(container)).toBe('r1:2;r2:2;');

	const kinds = new Set(tracer.events().map((e) => e.kind));
	// Write class
	expect(kinds).toContain('write');
	expect(kinds).toContain('batch-open');
	// Pass lifecycle class
	expect(kinds).toContain('pass-start');
	expect(kinds).toContain('pass-end');
	// Per-root commit class
	expect(kinds).toContain('root-commit');
	// Retirement class
	expect(kinds).toContain('batch-retire');
	// Delivery class
	expect(kinds).toContain('delivery');
	// Fixup class: every mount produced a disposition record, and the late
	// mount under a live batch scheduled a value-blind corrective.
	expect(kinds).toContain('mount-fixup');
	expect(kinds).toContain('mount-corrective');
	const fixups = tracer.events().filter((e) => e.kind === 'mount-fixup');
	expect(fixups.length).toBeGreaterThanOrEqual(2); // r1 mount + r2 late mount
	tracer.stop();
});
