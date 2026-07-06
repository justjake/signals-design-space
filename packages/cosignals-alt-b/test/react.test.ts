// M5 — React bindings driven by the fork double: per-root committed views and
// per-root effect flush (§13.4), the world-aware post-subscribe fixup with
// batch entanglement (§13.2), component-owned nodes (§13.3/§13.5), the
// transition helper (§13.6), and SSR serialize/initialize (§13.8).
import { beforeEach, describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	ForkDouble,
	__debug,
	__resetEngineForTests,
	attachFork,
} from '../src/index';
import {
	createReactBindings,
	initializeAtomState,
	serializeAtomState,
} from '../src/react';
import type { ReactBindings } from '../src/react';

let fork: ForkDouble;
let bindings: ReactBindings;

beforeEach(() => {
	__resetEngineForTests();
	fork = new ForkDouble();
	attachFork(fork);
	bindings = createReactBindings(fork);
});

const microtask = () => Promise.resolve();

describe('per-root committed views (§13.4)', () => {
	it('a batch spanning two roots: committed on A while pending on B', () => {
		const a = new Atom({ state: 0 });
		// Materialize both root views before the batch (mount order).
		bindings.rootView('A');
		bindings.rootView('B');
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1));
		fork.commitBatchOnRoot('A', k); // root A's DOM now shows 1
		expect(bindings.readRootCommitted('A', () => a.state)).toBe(1); // lock-in
		expect(bindings.readRootCommitted('B', () => a.state)).toBe(0); // nothing committed there
		expect(__debug.committed(() => a.state)).toBe(0); // global form excludes it too
		fork.retireBatch(k, true, 'B'); // final root commits; token retires
		expect(bindings.readRootCommitted('A', () => a.state)).toBe(1);
		expect(bindings.readRootCommitted('B', () => a.state)).toBe(1);
		expect(__debug.committed(() => a.state)).toBe(1);
	});

	it('computeds resolve through the per-root view as well', () => {
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state * 10 });
		expect(c.state).toBe(0);
		bindings.rootView('A');
		bindings.rootView('B');
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(2));
		fork.commitBatchOnRoot('A', k);
		expect(bindings.readRootCommitted('A', () => c.state)).toBe(20);
		expect(bindings.readRootCommitted('B', () => c.state)).toBe(0);
		fork.retireBatch(k, true, 'B');
		expect(bindings.readRootCommitted('B', () => c.state)).toBe(20);
	});
});

describe('useSignalEffect over per-root committed views (§13.4)', () => {
	it("root A's effects observe the batch at A's commit; root B's only at B's", async () => {
		const a = new Atom({ state: 0 });
		const seenA: number[] = [];
		const seenB: number[] = [];
		const effA = bindings.signalEffect('A', () => {
			seenA.push(a.state); // resolves in A's committed view
		});
		const effB = bindings.signalEffect('B', () => {
			seenB.push(a.state);
		});
		effA.commit();
		effB.commit();
		expect(seenA).toEqual([0]);
		expect(seenB).toEqual([0]);
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(5));
		fork.commitBatchOnRoot('A', k);
		await microtask();
		expect(seenA).toEqual([0, 5]); // A's committed world changed
		expect(seenB).toEqual([0]); // B's did not
		fork.retireBatch(k, true, 'B');
		await microtask();
		expect(seenB).toEqual([0, 5]); // B flushes at B's commit
		effA.unmount();
		effB.unmount();
	});

	it('cleanup runs before re-run and on unmount', async () => {
		const a = new Atom({ state: 0 });
		const log: string[] = [];
		const eff = bindings.signalEffect('A', () => {
			const v = a.state;
			log.push(`run:${v}`);
			return () => log.push(`cleanup:${v}`);
		});
		eff.commit();
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1));
		fork.retireBatch(k, true, 'A');
		await microtask();
		expect(log).toEqual(['run:0', 'cleanup:0', 'run:1']);
		eff.unmount();
		expect(log).toEqual(['run:0', 'cleanup:0', 'run:1', 'cleanup:1']);
	});
});

describe('useSignal: render read + post-subscribe fixup (§13.2)', () => {
	it('a mount inside a transition pass reads the pending world with NO spurious fixup', () => {
		const a = new Atom({ state: 0 });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1));
		const hook = bindings.mountSignal(a);
		fork.startRenderPass('root', [k]);
		expect(hook.renderRead()).toBe(1); // the pending world, directly
		fork.endRenderPass();
		hook.commit();
		// Committed state excludes k BY DEFINITION — the world-aware
		// comparison must not fire a correction for that.
		expect(hook.setStates).toEqual([]);
		fork.retireBatch(k, true);
		hook.unmount();
	});

	it('late subscriber: corrective setState entangled into the pending batch', () => {
		const a = new Atom({ state: 0 });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1)); // before any subscriber exists
		const hook = bindings.mountSignal(a);
		fork.startRenderPass('root', []); // this component's pass excludes k
		expect(hook.renderRead()).toBe(0);
		fork.endRenderPass();
		const entanglesBefore = fork.entangleLog.length;
		hook.commit();
		expect(hook.setStates).toEqual([{ token: k, reason: 'fixup-pending' }]);
		// The correction ran inside runInBatch(k) — it renders and commits
		// WITH the batch (one commit), not after it.
		expect(fork.entangleLog.slice(entanglesBefore)).toEqual([{ token: k, ran: true }]);
		fork.retireBatch(k, true);
		hook.unmount();
	});

	it('fallback: the batch retires between render and commit → urgent correction', () => {
		const a = new Atom({ state: 0 });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1));
		const hook = bindings.mountSignal(a);
		fork.startRenderPass('root', []);
		expect(hook.renderRead()).toBe(0);
		fork.endRenderPass();
		fork.retireBatch(k, true); // absorbed into committed state
		hook.commit();
		// Check 1's world resolves all retired history: 1 ≠ rendered 0.
		expect(hook.setStates).toEqual([{ token: 0, reason: 'fixup-own' }]);
		hook.unmount();
	});

	it('ongoing writes reach the mounted hook through the watcher, in the writer lane', () => {
		const a = new Atom({ state: 0 });
		const hook = bindings.mountSignal(a);
		const u = fork.openBatch(false);
		fork.startRenderPass('root', []);
		hook.renderRead();
		fork.endRenderPass();
		hook.commit();
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(3));
		expect(hook.setStates).toEqual([{ token: k, reason: 'watch' }]);
		fork.retireBatch(k, true);
		fork.retireBatch(u, false);
		hook.unmount();
	});
});

describe('component-owned nodes (§13.3/§13.5)', () => {
	it('ownedAtom/ownedComputed dispose deterministically and their records recycle', () => {
		const before = __debug.stats().recNext;
		const { atom, dispose } = bindings.ownedAtom({ state: 1 });
		const { computed, dispose: disposeC } = bindings.ownedComputed({
			fn: () => atom.state + 1,
		});
		expect(computed.state).toBe(2);
		disposeC(); // unmount order: consumers first
		dispose();
		const { atom: again } = bindings.ownedAtom({ state: 9 });
		expect(again.state).toBe(9);
		expect(__debug.stats().recNext).toBeLessThanOrEqual(before + 3 * 8);
		__debug.verify();
	});
});

describe('useSignalTransition analogue (§13.6)', () => {
	it('isPending tracks the token lifecycle; writes coalesce', () => {
		const a = new Atom({ state: 0 });
		const t = bindings.signalTransition();
		expect(t.isPending()).toBe(false);
		const token = t.start(() => {
			a.set(1);
			a.set(2);
		});
		expect(t.isPending()).toBe(true);
		expect(__debug.readInWorld(a, { kind: 'writer', token })).toBe(2);
		expect(__debug.committed(() => a.state)).toBe(0);
		fork.retireBatch(token, true);
		expect(t.isPending()).toBe(false);
		expect(a.state).toBe(2);
	});
});

describe('SSR serialize/initialize (§13.8)', () => {
	it('round-trips committed leaf values through JSON', () => {
		const count = new Atom({ state: 42 });
		const name = new Atom({ state: 'alien' });
		const json = serializeAtomState({ count, name });
		// "Client": fresh engine, same keys, constructor defaults.
		__resetEngineForTests();
		const fork2 = new ForkDouble();
		attachFork(fork2);
		const count2 = new Atom({ state: 0 });
		const name2 = new Atom({ state: '' });
		initializeAtomState(json, { count: count2, name: name2 });
		expect(count2.state).toBe(42);
		expect(name2.state).toBe('alien');
		// The install ran before any pass: it is plain committed history.
		expect(__debug.committed(() => count2.state)).toBe(42);
	});

	it('serializes the COMMITTED world, not pending transitions', () => {
		const a = new Atom({ state: 1 });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(99));
		expect(serializeAtomState({ a })).toBe('{"a":1}');
		fork.retireBatch(k, true);
		expect(serializeAtomState({ a })).toBe('{"a":99}');
	});
});
