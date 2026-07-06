import { describe, expect, it } from 'vitest';
import { createCosignalEngine, type CosignalEngine } from '../src/engine';
import { createForkDouble, type ForkDouble } from '../src/fork-double';

// §17.5 invisibility tests (compact form): a behavior battery must produce
// identical observable results
//   (a) in DIRECT mode (the donor-kernel semantics),
//   (b) in LOGGED mode where every write opens a synthetic deferred batch and
//       immediately retires+absorbs it, and
//   (c) in LOGGED mode while an UNRELATED live deferred batch holds a log on
//       an unrelated atom (marks live somewhere else).
// The overlay must be semantically invisible both when it contains
// everything and when it contains nothing relevant.
//
// The full frozen-kernel contract suite (behavioral identity with the
// pre-overlay artifact build, notify-set and flags-word comparison) is
// deferred beyond this pass.

type Battery = {
	log: unknown[];
};

function runBattery(
	e: CosignalEngine,
	write: (h: { set(v: number): void; update(f: (x: number) => number): void }, kind: 'set' | 'update', v: number) => void,
): Battery {
	const log: unknown[] = [];
	const a = e.atom(1);
	const b = e.atom(10);
	let cEvals = 0;
	const c = e.computed(() => {
		++cEvals;
		return a.state + b.state;
	});
	const parity = e.computed(() => a.state % 2);
	let dEvals = 0;
	const d = e.computed(() => {
		++dEvals;
		return parity.state * 100;
	});
	const effectSeen: unknown[] = [];
	const disposeEffect = e.effect(() => {
		effectSeen.push(c.state);
	});

	log.push(['initial', c.state, d.state]);
	write(a, 'set', 3); // c: 13; parity 1→1 (cutoff for d)
	log.push(['after a=3', c.state, d.state]);
	write(a, 'update', 1); // a=4 → c 14; parity 0 → d 0
	log.push(['after a+=1', c.state, d.state]);
	e.batch(() => {
		write(a, 'set', 5);
		write(b, 'set', 20);
	});
	log.push(['after batch', c.state, d.state, effectSeen.slice()]);
	write(a, 'set', 5); // equal write: nothing re-runs
	log.push(['after equal write', c.state, effectSeen.length]);
	disposeEffect();
	write(a, 'set', 7);
	log.push(['after dispose', c.state, effectSeen.length]);
	// Eval counts are deliberately NOT part of the battery log: with live
	// marks the overlay legally re-evaluates more often (the priced cost
	// model, §10.5/G-8); invisibility is about ANSWERS. Exact pull counts in
	// DIRECT mode are pinned by kernel.spec. Reference the counters so the
	// battery still exercises them.
	void cEvals;
	void dEvals;
	return { log };
}

function directBattery(): Battery {
	const e = createCosignalEngine();
	return runBattery(e, (h, kind, v) => (kind === 'set' ? h.set(v) : h.update((x) => x + v)));
}

describe('§17.5 invisibility', () => {
	it('(a) synthetic deferred batch + immediate retirement per write ≡ DIRECT', () => {
		const e = createCosignalEngine();
		const fork = createForkDouble();
		e.attachFork(fork);
		fork.registerRoot('root');
		const out = runBattery(e, (h, kind, v) => {
			const batch = fork.openBatch('deferred');
			batch.run(() => (kind === 'set' ? h.set(v) : h.update((x) => x + v)));
			batch.retire(true);
		});
		expect(out.log).toEqual(directBattery().log);
		expect(e.debug.quiescent()).toBe(true);
		e.debug.verify();
	});

	it('(b) an unrelated live deferred batch does not perturb steady answers', () => {
		const e = createCosignalEngine();
		const fork = createForkDouble();
		e.attachFork(fork);
		fork.registerRoot('root');
		// The unrelated region: a live deferred batch holding a log elsewhere.
		const unrelated = e.atom(1000);
		const unrelatedC = e.computed(() => unrelated.state * 2);
		expect(unrelatedC.state).toBe(2000);
		const t = fork.openBatch('deferred');
		t.run(() => unrelated.set(1234));
		expect(e.debug.loggedAtomCount()).toBeGreaterThan(0);

		const out = runBattery(e, (h, kind, v) => {
			(kind === 'set' ? h.set(v) : h.update((x) => x + v));
			fork.closeEvent(); // retire each urgent event so committed tracks
		});
		expect(out.log).toEqual(directBattery().log);
		// The unrelated pending world stayed pending throughout.
		expect(e.debug.readWorld(unrelatedC, { kind: 'writer', token: t.token })).toBe(2468);
		expect(e.debug.readWorld(unrelatedC, { kind: 'w0' })).toBe(2000);
		t.retire();
		expect(e.debug.readWorld(unrelatedC, { kind: 'w0' })).toBe(2468);
		e.debug.verify();
	});

	it('(c) mounted-but-quiet: LOGGED steady state answers like DIRECT with watchers attached', () => {
		const e = createCosignalEngine();
		const fork = createForkDouble();
		e.attachFork(fork);
		fork.registerRoot('root');
		const a = e.atom(1);
		const c = e.computed(() => a.state * 3);
		const seen: unknown[] = [];
		e.watch(c, (ev) => seen.push([ev.token, ev.value]));
		for (let i = 2; i <= 5; ++i) {
			a.set(i);
			fork.closeEvent();
		}
		expect(c.state).toBe(15);
		expect(seen).toEqual([[0, 6], [0, 9], [0, 12], [0, 15]]);
		expect(e.debug.quiescent()).toBe(true);
		expect(e.debug.planeResidue()).toEqual({ g: true, w: true });
		e.debug.verify();
	});
});
