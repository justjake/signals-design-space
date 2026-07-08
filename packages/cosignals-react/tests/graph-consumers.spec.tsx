/**
 * GRAPH-CONSUMER COHERENCE AUDIT — bindings rows. The engine-side table
 * lives in cosignals/tests/graph-consumers.spec.ts; the shim rows it cites:
 *
 *  19/21  shim unsubscribe paths (debounce-finalized unsubscribe, StrictMode
 *         orphan sweep) retire watchers through the engine's removeWatcher,
 *         so the id map, the per-node walk index, open mounted lists, and
 *         the observation retain move TOGETHER. A map-only delete (the
 *         pre-fix shape) strands the per-node entry: dead watchers keep
 *         seeding the engine's K1 sweep reachability and its quiescence
 *         refresh targets forever. Pinned here through the quiescence
 *         observable — a stranded entry re-evaluates the dead watcher's
 *         node at quiesce().
 *  22     useSignal's render branches key on engine watcher records only
 *         (mount / re-render / reveal) — enforced by hooks.spec.tsx and
 *         battery.spec.tsx (StrictMode netting, Activity reveal scenarios).
 *  23     committed-subscription dep snapshots (the engine's captureRun —
 *         the promoted useSignalEffect mechanism) compare committed-world
 *         VALUES at EF2 boundaries, no edge store — enforced by
 *         hooks.spec.tsx useSignalEffect + battery EF2 boundary suites.
 */
import { describe, expect, test, afterEach } from 'vitest';
import * as React from 'react';
import { Atom } from 'cosignals';
import { useSignal, useComputed } from '../src/index.js';
import { makeHarness, act, text, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
	await h.cleanup();
});

describe('rows 19/21 — shim unsubscribe keeps every watcher store coherent (removeWatcher)', () => {
	test('debounce-finalized unsubscribe: unmount empties the id map AND the per-node walk index', async () => {
		h = makeHarness();
		const a = new Atom(1);
		let evals = 0;
		function View() {
			const c = useComputed(() => {
				evals++;
				return a.state * 2;
			}, []);
			return <span>{useSignal(c)}</span>;
		}
		const { root, container } = await h.mount(<View />);
		expect(text(container)).toBe('2');
		expect(h.engine.watchers.size).toBe(1);
		await act(async () => {
			root.render(<span>gone</span>); // component unmounts; cleanup queues the debounced unsub
		});
		await act(async () => {}); // debounce microtask fires → finalizeUnsub → engine.removeWatcher
		expect(h.engine.watchers.size).toBe(0);
		const before = evals;
		h.engine.quiesce(); // refresh targets = K1-touched nodes still holding watchers
		expect(evals).toBe(before); // a stranded per-node entry would re-evaluate the dead node here
	});

	test('StrictMode orphan sweep: discarded double-mount watchers leave no store behind', async () => {
		h = makeHarness();
		const a = new Atom(1);
		let evals = 0;
		function View() {
			const c = useComputed(() => {
				evals++;
				return a.state + 10;
			}, []);
			return <span>{useSignal(c)}</span>;
		}
		const { root, container } = await h.mount(
			<React.StrictMode>
				<View />
			</React.StrictMode>,
		);
		expect(text(container)).toBe('11');
		await act(async () => {}); // orphan sweep + unsub debounce settle
		expect(h.engine.watchers.size).toBe(1); // the double-mount netted to one live watcher
		await act(async () => {
			root.render(<span>gone</span>);
		});
		await act(async () => {}); // debounce-finalized unsubscribe for the survivor
		expect(h.engine.watchers.size).toBe(0);
		const before = evals;
		h.engine.quiesce();
		expect(evals).toBe(before); // neither the swept orphans nor the survivor left an index entry
	});
});
