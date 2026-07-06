// M4 — policy extras: observed-lifecycle effect (§12.4), LIVE-bit flow (§8.6),
// UPDATE/DISPATCH composition coalescing with the identity-equality gate
// (§9.3 + alt-a's finding), the replay-purity debug assertion (§12.2),
// FinalizationRegistry reclamation behind a flag (§14.2), and the transition
// helper (§13.6).
import { beforeEach, describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	ForkDouble,
	ReducerAtom,
	__debug,
	__resetEngineForTests,
	attachFork,
	configure,
	createWatcher,
	effect,
	startSignalTransition,
} from '../src/index';

let fork: ForkDouble;

beforeEach(() => {
	__resetEngineForTests();
	fork = new ForkDouble();
	attachFork(fork);
});

const microtask = () => Promise.resolve();

describe('LIVE-bit liveness (§8.6)', () => {
	it('flows down from effects through computeds to atoms, and clears on dispose', () => {
		const a = new Atom({ state: 1 });
		const c = new Computed({ fn: () => a.state + 1 });
		expect(__debug.isLive(a)).toBe(false);
		expect(c.state).toBe(2); // plain read: nothing becomes LIVE
		expect(__debug.isLive(a)).toBe(false);
		expect(__debug.isLive(c)).toBe(false);
		const dispose = effect(() => {
			void c.state;
		});
		expect(__debug.isLive(c)).toBe(true);
		expect(__debug.isLive(a)).toBe(true);
		dispose();
		expect(__debug.isLive(c)).toBe(false);
		expect(__debug.isLive(a)).toBe(false);
	});

	it('watchers make the watched subtree LIVE; last-unsubscribe clears it', () => {
		const a = new Atom({ state: 1 });
		const c = new Computed({ fn: () => a.state * 2 });
		expect(c.state).toBe(2);
		const w1 = createWatcher(c, () => {});
		const w2 = createWatcher(c, () => {});
		expect(__debug.isLive(a)).toBe(true);
		w1.dispose();
		expect(__debug.isLive(a)).toBe(true); // w2 still watching
		w2.dispose();
		expect(__debug.isLive(a)).toBe(false);
	});

	it('a branch flip moves the liveness boundary with the dependency', () => {
		const flag = new Atom({ state: true });
		const x = new Atom({ state: 1 });
		const y = new Atom({ state: 2 });
		const c = new Computed({ fn: () => (flag.state ? x.state : y.state) });
		createWatcher(c, () => {});
		expect(__debug.isLive(x)).toBe(true);
		expect(__debug.isLive(y)).toBe(false);
		flag.set(false);
		expect(c.state).toBe(2); // re-evaluate down the y branch
		expect(__debug.isLive(y)).toBe(true);
		expect(__debug.isLive(x)).toBe(false); // trimmed dep lost liveness
	});
});

describe('atom observed-lifecycle (§12.4)', () => {
	it('mounts on first observation, cleans up on last unobservation (microtask)', async () => {
		const log: string[] = [];
		const a = new Atom<number>({
			state: 0,
			effect: (ctx) => {
				log.push(`mount:${ctx.peek()}`);
				ctx.set(42); // remote subscription pushes an initial value
				return () => log.push('cleanup');
			},
		});
		const c = new Computed({ fn: () => a.state + 1 });
		expect(c.state).toBe(1);
		expect(log).toEqual([]); // unobserved: effect never ran
		const w = createWatcher(c, () => {});
		await microtask();
		expect(log).toEqual(['mount:0']);
		expect(a.state).toBe(42); // the ctx.set landed as an ordinary write
		expect(c.state).toBe(43);
		w.dispose();
		await microtask();
		expect(log).toEqual(['mount:0', 'cleanup']);
	});

	it('an observe/unobserve flap within one tick nets to no churn', async () => {
		const log: string[] = [];
		const a = new Atom<number>({
			state: 0,
			effect: () => {
				log.push('mount');
				return () => log.push('cleanup');
			},
		});
		const w = createWatcher(a, () => {});
		w.dispose(); // same tick: strict-mode-style flap
		await microtask();
		expect(log).toEqual([]); // debounced to nothing
		const w2 = createWatcher(a, () => {});
		await microtask();
		expect(log).toEqual(['mount']);
		w2.dispose();
		await microtask();
		expect(log).toEqual(['mount', 'cleanup']);
	});
});

describe('coalescing: identity-equality gate and composition (§9.3)', () => {
	it('SET coalescing is disabled for atoms with custom isEqual (alt-a finding)', () => {
		const a = new Atom({ state: { v: 0 }, isEqual: (x, y) => x.v === y.v });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set({ v: 1 }));
		const afterFirst = __debug.stats().gNext;
		fork.inBatch(k, () => a.set({ v: 2 }));
		fork.inBatch(k, () => a.set({ v: 3 }));
		// No in-place replacement: every write appended its own receipt.
		expect(__debug.stats().gNext).toBeGreaterThan(afterFirst);
		fork.retireBatch(k, true);
		expect(a.state.v).toBe(3);
	});

	it('reference identity is preserved through equality folds (why the gate exists)', () => {
		const first = { v: 1 };
		const a = new Atom({ state: { v: 0 }, isEqual: (x, y) => x.v === y.v });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(first));
		fork.inBatch(k, () => a.set({ v: 1 })); // equal by policy, appended
		// The world fold keeps the EARLIER reference when isEqual holds; if
		// the second SET had replaced the first in place, this identity would
		// have silently changed.
		expect(__debug.readInWorld(a, { kind: 'writer', token: k })).toBe(first);
		fork.retireBatch(k, true);
		expect(a.state).toBe(first);
	});

	it('UPDATE runs compose past the threshold, bounding tape growth', () => {
		const a = new Atom({ state: 0 });
		const k = fork.openBatch(true);
		for (let i = 0; i < 8; ++i) {
			fork.inBatch(k, () => a.update((x) => x + 1));
		}
		const atThreshold = __debug.stats().gNext;
		for (let i = 0; i < 20; ++i) {
			fork.inBatch(k, () => a.update((x) => x + 1));
		}
		// Composition onto the tail: no further log records allocated.
		expect(__debug.stats().gNext).toBe(atThreshold);
		expect(__debug.readInWorld(a, { kind: 'writer', token: k })).toBe(28);
		expect(__debug.committed(() => a.state)).toBe(0);
		fork.retireBatch(k, true);
		expect(a.state).toBe(28);
		__debug.verify();
	});

	it('DISPATCH runs compose and replay correctly per world', () => {
		const r = new ReducerAtom<number, number>({ state: 0, reducer: (s, x) => s + x });
		const k = fork.openBatch(true);
		const u = fork.openBatch(false);
		for (let i = 1; i <= 12; ++i) {
			fork.inBatch(k, () => r.dispatch(i));
		}
		fork.inBatch(u, () => r.dispatch(1000)); // urgent lands over the composition
		expect(__debug.kernelValue(r)).toBe(1000);
		expect(__debug.readInWorld(r, { kind: 'writer', token: k })).toBe(78 + 1000);
		fork.retireBatch(u, true);
		fork.retireBatch(k, true);
		expect(r.state).toBe(1078);
		__debug.verify();
	});
});

describe('replay-purity debug assertion (§12.2)', () => {
	it('an updater reading a signal trips the assertion', () => {
		const a = new Atom({ state: 1 });
		const b = new Atom({ state: 10 });
		expect(() => a.update((x) => x + b.state)).toThrow(/pure|replay/);
	});

	it('a reducer reading a signal trips during a world fold', () => {
		const other = new Atom({ state: 5 });
		const r = new ReducerAtom<number, number>({
			state: 0,
			reducer: (s, x) => s + x + other.state, // impure
		});
		const k = fork.openBatch(true);
		expect(() => fork.inBatch(k, () => r.dispatch(1))).toThrow(/pure|replay/);
		fork.retireBatch(k, false);
	});

	it('configure({ debugChecks: false }) disables the assertion (documented user error)', () => {
		configure({ debugChecks: false });
		const a = new Atom({ state: 1 });
		const b = new Atom({ state: 10 });
		a.update((x) => x + b.state);
		expect(a.state).toBe(11);
		configure({ debugChecks: true });
	});

	it('capturing values before the write is the supported pattern', () => {
		const a = new Atom({ state: 1 });
		const b = new Atom({ state: 10 });
		const captured = b.state;
		a.update((x) => x + captured);
		expect(a.state).toBe(11);
	});
});

describe('FinalizationRegistry reclamation (§14.2, behind a flag)', () => {
	it('finalizing an unreferenced atom frees its record for reuse', () => {
		configure({ finalization: true });
		const a = new Atom({ state: 1 });
		const before = __debug.stats().recNext;
		__debug.simulateFinalize(a);
		const b = new Atom({ state: 2 }); // should reuse the freed record
		expect(__debug.stats().recNext).toBe(before);
		expect(b.state).toBe(2);
		__debug.verify();
		configure({ finalization: false });
	});

	it('skips records that are still subscribed-to (leak-safe)', () => {
		configure({ finalization: true });
		const a = new Atom({ state: 1 });
		const c = new Computed({ fn: () => a.state + 1 });
		expect(c.state).toBe(2);
		createWatcher(c, () => {});
		__debug.simulateFinalize(a); // a has a live subscriber: must not free
		a.set(5);
		expect(c.state).toBe(6);
		__debug.verify();
		configure({ finalization: false });
	});

	it('stale finalizations are defused by the generation counter', () => {
		configure({ finalization: true });
		const a = new Atom({ state: 1 });
		const gen = 0; // wrong generation on purpose
		__debug.simulateFinalize(a, gen - 1);
		expect(a.state).toBe(1); // untouched
		configure({ finalization: false });
	});
});

describe('startSignalTransition (§13.6)', () => {
	it('coalesces broadcasts: N writes, one notify per watcher, deferred lane', () => {
		const a = new Atom({ state: 0 });
		const b = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state + b.state });
		expect(c.state).toBe(0);
		const notifications: number[] = [];
		createWatcher(c, (token) => notifications.push(token));
		const token = startSignalTransition(() => {
			a.set(1);
			b.set(2);
		});
		expect(token & 1).toBe(1); // deferred
		expect(notifications).toEqual([token]); // one drain, one setState
		expect(__debug.committed(() => c.state)).toBe(0);
		expect(__debug.readInWorld(c, { kind: 'writer', token })).toBe(3);
		fork.retireBatch(token, true);
		expect(c.state).toBe(3);
	});
});
