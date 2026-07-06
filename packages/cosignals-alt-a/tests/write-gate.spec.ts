import { describe, expect, it } from 'vitest';
import { createCosignalEngine } from '../src/engine';
import { createForkDouble } from '../src/fork-double';

// §17.6 write-gate contract family (fork-double analogs of the React tests).
// These are the permanent gatekeepers for any future write-mode-gate change.

function activated() {
	const e = createCosignalEngine();
	const fork = createForkDouble();
	e.attachFork(fork);
	fork.registerRoot('root');
	return { e, fork };
}

describe('write-gate contract (i): exact parity for idle writes', () => {
	it('a flushSync-analog pass excluding an idle write’s batch reads the pre-write value from the receipt', () => {
		const { e, fork } = activated();
		const a = e.atom(42);
		const c = e.computed(() => a.state * 2);
		expect(c.state).toBe(84);
		// React fully idle. A timer fires and writes the atom (bare urgent).
		a.set(99);
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(99); // applied
		// Same task: a flushSync render that EXCLUDES the idle write's
		// default batch. Only the receipt lets it read the pre-write world.
		const pass = fork.startPass('root', { include: [] });
		expect(a.state).toBe(42); // useState-identical
		expect(c.state).toBe(84); // one computed downstream, same exclusion
		pass.end();
		expect(a.state).toBe(99);
		fork.closeEvent();
		expect(e.readCommitted(a)).toBe(99);
		e.debug.verify();
	});
});

describe('write-gate contract (ii): activation monotonicity', () => {
	it('never reverts: quiescence, unmounting every watcher, detaching listeners', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const w = e.watch(a);
		a.set(1);
		fork.closeEvent();
		expect(e.debug.quiescent()).toBe(true);
		expect(e.debug.mode()).toBe('LOGGED'); // quiescence does not revert
		w.dispose(); // last component unmounts
		expect(e.debug.mode()).toBe('LOGGED');
		a.set(2); // still logged
		expect(e.debug.isLogged(a)).toBe(true);
		fork.closeEvent();
		e.debug.verify();
	});
});

describe('write-gate contract (iii): the watcher-count counterexample', () => {
	it('the app’s FIRST transition writes before any watcher exists; a mid-transition subscriber reads both worlds correctly', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const c = e.computed(() => a.state + 1);
		expect(c.state).toBe(1);
		// No watcher exists anywhere. The first transition writes the signal.
		const t = fork.openBatch('deferred');
		t.run(() => a.set(10));
		// Activation preceded the transition, so the write WAS logged — a
		// watcher-count gate would have gone DIRECT here and left no receipt.
		expect(e.debug.isLogged(a)).toBe(true);
		// A subscriber "mounts during the transition's render".
		const pass = fork.startPass('root', { include: [t] });
		expect(c.state).toBe(11); // pending world, read directly
		pass.yield();
		e.watch(c); // commit-phase subscription in the gap
		pass.resume();
		expect(c.state).toBe(11);
		pass.end();
		// Both worlds answer correctly.
		expect(e.debug.readWorld(c, { kind: 'writer', token: t.token })).toBe(11);
		expect(e.readCommitted(c)).toBe(1); // committed world: pre-transition
		t.retire();
		expect(e.readCommitted(c)).toBe(11);
		e.debug.verify();
	});
});
