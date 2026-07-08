// M2 — tape mechanics: the quiescence write gate (§9.1), slot interning
// (§9.2), append/equality/receipt/coalescing (§9.3), applied/unapplied (§9.4),
// the deferred-notify matrix (§9.8), the gate counterexamples (§9.1/§17.6),
// and the quiescence reset (§9.7).
import { beforeEach, describe, expect, it } from 'vitest';
import {
	Atom,
	Computed,
	ForkDouble,
	__debug,
	__resetEngineForTests,
	attachFork,
	batch,
	configure,
	createWatcher,
	latest,
} from '../src/index';

let fork: ForkDouble;

beforeEach(() => {
	__resetEngineForTests();
	fork = new ForkDouble();
	attachFork(fork);
});

function passRead<T>(tokens: number[], read: () => T): T {
	fork.startRenderPass('root', tokens);
	try {
		return read();
	} finally {
		fork.endRenderPass();
	}
}

describe('the write gate (§9.1)', () => {
	it('DIRECT while React is fully quiescent; writes commit with no receipt', () => {
		const a = new Atom({ state: 0 });
		expect(__debug.isDirect()).toBe(true);
		a.set(1);
		expect(a.state).toBe(1);
		expect(__debug.stats().gNext).toBe(4); // no log record allocated
		expect(__debug.stats().loggedAtomCount).toBe(0);
	});

	it('flips LOGGED on the batch-open edge, before any write it could affect', () => {
		const a = new Atom({ state: 0 });
		const t = fork.openBatch(true);
		expect(__debug.isDirect()).toBe(false);
		fork.inBatch(t, () => a.set(1));
		expect(__debug.stats().loggedAtomCount).toBe(1); // the write was logged
		fork.retireBatch(t, true);
		expect(a.state).toBe(1);
		expect(__debug.isDirect()).toBe(true); // DIRECT again at full quiescence
	});

	it('flips LOGGED on pass start too, and stays LOGGED until full quiescence', () => {
		const t = fork.openBatch(false);
		fork.startRenderPass('root', [t]);
		expect(__debug.isDirect()).toBe(false);
		fork.endRenderPass();
		expect(__debug.isDirect()).toBe(false); // batch still live
		fork.retireBatch(t, true);
		expect(__debug.isDirect()).toBe(true);
	});

	it('loose default: an idle-time write is visible to every subsequent pass', () => {
		const a = new Atom({ state: 0 });
		a.set(1); // fully idle: DIRECT, committed immediately, no receipt
		// A later flushSync-like pass that excludes everything still sees it —
		// it is committed history (the documented loose contract).
		const u = fork.openBatch(false);
		const seen = passRead([u], () => a.state);
		expect(seen).toBe(1);
		fork.retireBatch(u, false);
	});

	it('strictLanes: the same idle write is logged and excluded like useState', () => {
		configure({ strictLanes: true });
		expect(__debug.isDirect()).toBe(false); // pinned LOGGED once attached
		const a = new Atom({ state: 0 });
		a.set(1); // logs under the ambient urgent token
		const ambient = fork.getCurrentWriteBatch();
		// flushSync-like pass excluding the ambient batch: parity with useState —
		// the idle write is hidden from it.
		const u = fork.openBatch(false);
		expect(passRead([u], () => a.state)).toBe(0);
		// A pass including the ambient batch sees it.
		expect(passRead([ambient, u], () => a.state)).toBe(1);
		fork.retireBatch(u, false);
		fork.retireBatch(ambient, true);
		expect(a.state).toBe(1); // converged
		expect(__debug.isDirect()).toBe(false); // strictLanes never reverts
		configure({ strictLanes: false });
	});

	it('watcher-count counterexample: first-ever transition write is logged even with no watcher', () => {
		const a = new Atom({ state: 0 });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1));
		// A component mounting mid-transition can read both worlds correctly:
		expect(__debug.committed(() => a.state)).toBe(0);
		expect(__debug.readInWorld(a, { kind: 'writer', token: k })).toBe(1);
		fork.retireBatch(k, true);
		expect(__debug.committed(() => a.state)).toBe(1);
	});
});

describe('always-log inside LOGGED mode: the flushSync-exclusion case (§9.1)', () => {
	it('an urgent write is logged so an excluding pass can reconstruct the older world', () => {
		const a = new Atom({ state: 3 });
		const d = fork.openBatch(true); // pending default/transition batch
		fork.inBatch(d, () => a.set(5)); // deferred, unapplied
		const u = fork.openBatch(false);
		fork.inBatch(u, () => a.update((x) => x * 2)); // urgent, logged AND applied
		// W0 (kernel): base 3 doubled = 6; the deferred 5 is not applied.
		expect(__debug.kernelValue(a)).toBe(6);
		// flushSync-like render including only U: the world where the urgent
		// write happened but the earlier batch has not.
		expect(passRead([u], () => a.state)).toBe(6);
		// Ambient (SPEC-RESOLUTIONS §ambient-W0): the deferred draft is
		// INVISIBLE — top-level reads see W0 (6). latest() is THE Wn read.
		expect(a.state).toBe(6);
		expect(latest(a)).toBe(10); // Wn incl. drafts: 5 * 2
		// Committed sees neither.
		expect(__debug.committed(() => a.state)).toBe(3);
		fork.retireBatch(u, true);
		fork.retireBatch(d, true);
		expect(a.state).toBe(10); // both retired: W0 folds everything
	});

	it('one-computed-downstream variant: tape creation marks the cone for urgent writes too (§9.3)', () => {
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state + 1 });
		expect(c.state).toBe(1); // canonical evaluation, cached
		const u = fork.openBatch(false);
		fork.inBatch(u, () => a.set(2)); // urgent write CREATES the tape
		// COMMITTED must exclude the applied-but-unretired entry — one node
		// downstream of the tape. Without mark-on-creation this would read the
		// kernel cache (3): the unmarked-cone tear.
		expect(__debug.committed(() => c.state)).toBe(1);
		expect(c.state).toBe(3); // newest
		fork.retireBatch(u, true);
		expect(__debug.committed(() => c.state)).toBe(3);
	});
});

describe('equality and receipts (§9.3)', () => {
	it('equal write to a tapeless atom is dropped (no tape created)', () => {
		const a = new Atom({ state: 7 });
		const k = fork.openBatch(true);
		const before = __debug.stats().gNext;
		fork.inBatch(k, () => a.set(7));
		expect(__debug.stats().gNext).toBe(before);
		expect(__debug.stats().loggedAtomCount).toBe(0);
		fork.retireBatch(k, false);
	});

	it('UPDATE on a tapeless atom is evaluated once against the base for the drop check', () => {
		const a = new Atom({ state: 7 });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.update((x) => x)); // identity: equal, dropped
		expect(__debug.stats().loggedAtomCount).toBe(0);
		fork.retireBatch(k, false);
	});

	it('equal urgent SET over a pending transition still appends (the receipt must not be dropped)', () => {
		const a = new Atom({ state: 0 });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1)); // pending transition writes 1
		const u = fork.openBatch(false);
		fork.inBatch(u, () => a.set(1)); // equal to newest 1 — but must log
		// The urgent-only world reads 1 because ITS receipt exists; dropping it
		// would have made this pass read 0.
		expect(passRead([u], () => a.state)).toBe(1);
		expect(__debug.committed(() => a.state)).toBe(0);
		fork.retireBatch(u, true);
		fork.retireBatch(k, true);
		expect(a.state).toBe(1);
	});
});

describe('the rebase walkthrough (§10.7)', () => {
	it('functional updates replay in seq order over each world', () => {
		const a = new Atom({ state: 1 });
		const t = fork.openBatch(true);
		fork.inBatch(t, () => a.update((x) => x + 1)); // deferred
		const u = fork.openBatch(false);
		fork.inBatch(u, () => a.update((x) => x * 2)); // urgent
		// Kernel (W0) = base + applied = 1 * 2 = 2.
		expect(__debug.kernelValue(a)).toBe(2);
		// Urgent render (includes U, not T): the click's doubling shows.
		expect(passRead([u], () => a.state)).toBe(2);
		fork.retireBatch(u, true); // absorption fold unchanged: no-op
		expect(__debug.kernelValue(a)).toBe(2);
		// Transition render (includes T; U retired before its pin): rebase.
		expect(passRead([t], () => a.state)).toBe(4);
		fork.retireBatch(t, true);
		expect(__debug.kernelValue(a)).toBe(4); // exactly what useState computes
		expect(a.state).toBe(4);
		// Full quiescence: overlay residue is zero.
		const s = __debug.stats();
		expect(s.gNext).toBe(4);
		expect(s.wNext).toBe(8);
		expect(s.certNext).toBe(0);
		expect(s.seqCounter).toBe(1);
		expect(s.liveSlotMask).toBe(0);
		expect(s.writeMode).toBe('DIRECT');
		__debug.verify();
	});
});

describe('deferred-write notification (§9.8)', () => {
	it('two-batch re-notify: a second write from a different batch into an already-marked region reaches watchers', () => {
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state * 10 });
		expect(c.state).toBe(0);
		const notifications: number[] = [];
		createWatcher(c, (token) => notifications.push(token));
		const t1 = fork.openBatch(true);
		const t2 = fork.openBatch(true);
		fork.inBatch(t1, () => a.set(1));
		expect(notifications).toEqual([t1]);
		fork.inBatch(t2, () => a.set(2)); // region already marked — must still notify
		expect(notifications).toEqual([t1, t2]);
		// And each notification ran inside its own batch's entanglement scope.
		expect(fork.entangleLog.filter((e) => e.ran).map((e) => e.token)).toEqual([t1, t2]);
		fork.retireBatch(t1, true);
		fork.retireBatch(t2, true);
	});

	it('same-batch second write after a cutoff-suppressed first write still notifies', () => {
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state >= 2 });
		expect(c.state).toBe(false);
		const notifications: number[] = [];
		createWatcher(c, (token) => notifications.push(token));
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1)); // c stays false in k's world: suppressed
		expect(notifications).toEqual([]);
		fork.inBatch(k, () => a.set(5)); // now c flips true in k's world
		expect(notifications).toEqual([k]);
		fork.retireBatch(k, true);
	});

	it('urgent-then-deferred and deferred-then-urgent on one atom', () => {
		const a = new Atom({ state: 0 });
		const notifications: Array<[number, unknown]> = [];
		createWatcher(a, (token) => notifications.push([token, a.state]));
		const u = fork.openBatch(false);
		const k = fork.openBatch(true);
		fork.inBatch(u, () => a.set(1)); // urgent: token 0 broadcast (W0 changed)
		fork.inBatch(k, () => a.set(2)); // deferred: token k broadcast
		fork.inBatch(u, () => a.set(3)); // urgent again: fires 0 AND k — the
		// applied 3 also moves k's writer's world (2 → 3), so k's lane must
		// hear about it (§9.8 urgent-drain duties).
		expect(notifications.map(([t]) => t)).toEqual([0, k, 0, k]);
		fork.retireBatch(u, true);
		fork.retireBatch(k, true);
		// Replay in seq order: u:SET 1, k:SET 2, u:SET 3 → the final fold is 3
		// (k's SET has an earlier seq than u's last SET, so it cannot clobber it).
		expect(a.state).toBe(3);
	});

	it('grouped drain: one walk ticket, one notification per watcher per batch group', () => {
		const a = new Atom({ state: 0 });
		const b = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state + b.state });
		expect(c.state).toBe(0);
		const notifications: number[] = [];
		createWatcher(c, (token) => notifications.push(token));
		const k = fork.openBatch(true);
		batch(() => {
			fork.inBatch(k, () => {
				a.set(1);
				b.set(2);
			});
		});
		expect(notifications).toEqual([k]); // 2 writes, one drain, one setState
		fork.retireBatch(k, true);
	});

	it('retired-token drain falls back to an urgent broadcast', () => {
		const a = new Atom({ state: 0 });
		const notifications: number[] = [];
		createWatcher(a, (token) => notifications.push(token));
		const k = fork.openBatch(true);
		batch(() => {
			fork.inBatch(k, () => a.set(1));
			// The batch retires between the write and the grouped drain.
			fork.retireBatch(k, true);
		});
		// The drain's runInBatch(k) returned false; the group fell back.
		expect(notifications).toEqual([0]);
		expect(fork.entangleLog.some((e) => e.token === k && !e.ran)).toBe(true);
	});
});

describe('coalescing (§9.3)', () => {
	it('same-batch SET runs coalesce in place when no pass is open', () => {
		const a = new Atom({ state: 0 });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1));
		const afterFirst = __debug.stats().gNext;
		fork.inBatch(k, () => a.set(2));
		fork.inBatch(k, () => a.set(3));
		expect(__debug.stats().gNext).toBe(afterFirst); // no new records
		expect(__debug.readInWorld(a, { kind: 'writer', token: k })).toBe(3);
		fork.retireBatch(k, true);
		expect(a.state).toBe(3);
	});

	it('an open pass blocks coalescing (the pass may be pinned between the writes)', () => {
		const a = new Atom({ state: 0 });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1));
		const afterFirst = __debug.stats().gNext;
		const pin = __debug.seqCounter();
		fork.startRenderPass('root', [k]);
		fork.yieldPass(); // gap: writes are legal here
		fork.inBatch(k, () => a.set(2)); // appends, must not clobber the pinned 1
		expect(__debug.stats().gNext).toBeGreaterThan(afterFirst);
		fork.resumePass();
		expect(a.state).toBe(1); // RENDER context: the pass's pinned world
		fork.endRenderPass();
		// Ambient-W0: the still-pending draft is invisible; latest() sees it.
		expect(a.state).toBe(0);
		expect(latest(a)).toBe(2);
		expect(pin).toBeLessThan(__debug.seqCounter());
		fork.retireBatch(k, true);
		expect(a.state).toBe(2); // committed: now in W0
	});

	it('a coalesced write still notifies watchers', () => {
		const a = new Atom({ state: 0 });
		const notifications: number[] = [];
		createWatcher(a, (token) => notifications.push(token));
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1));
		fork.inBatch(k, () => a.set(2)); // coalesced in place
		expect(notifications).toEqual([k, k]);
		fork.retireBatch(k, true);
	});
});

describe('slot interning and exhaustion (§9.2)', () => {
	it('interns at most 32 slots; the 33rd live batch degrades toward urgent without crashing', () => {
		fork.maxLiveTokens = 40; // lift the double's own §6.2 cap to force the engine fallback
		const atoms = Array.from({ length: 33 }, () => new Atom({ state: 0 }));
		const tokens: number[] = [];
		for (let i = 0; i < 33; ++i) {
			const t = fork.openBatch(true);
			tokens.push(t);
			fork.inBatch(t, () => atoms[i].set(i + 1));
		}
		expect(__debug.stats().pseudoFallbacks).toBeGreaterThan(0);
		// The fallback write is applied (visible newest and in kernel).
		expect(atoms[32].state).toBe(33);
		expect(__debug.kernelValue(atoms[32])).toBe(33);
		for (const t of tokens) {
			fork.retireBatch(t, true);
		}
		for (let i = 0; i < 33; ++i) {
			expect(atoms[i].state).toBe(i + 1);
		}
		__debug.verify();
	});

	it('slot reuse after retirement keeps attribution correct', () => {
		const a = new Atom({ state: 0 });
		const k1 = fork.openBatch(true);
		fork.inBatch(k1, () => a.set(1));
		fork.retireBatch(k1, true);
		const k2 = fork.openBatch(true); // may reuse k1's slot
		fork.inBatch(k2, () => a.set(2));
		expect(__debug.committed(() => a.state)).toBe(1); // k1 absorbed, k2 pending
		expect(__debug.readInWorld(a, { kind: 'writer', token: k2 })).toBe(2);
		fork.retireBatch(k2, true);
		expect(a.state).toBe(2);
	});
});

describe('quiescence reset (§9.7)', () => {
	it('resets planes, seq counter, slot heads; write mode returns to DIRECT', () => {
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state + 1 });
		expect(c.state).toBe(1);
		createWatcher(c, () => {});
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(5));
		expect(__debug.stats().gNext).toBeGreaterThan(4);
		const epochBefore = __debug.stats().overlayEpoch;
		fork.retireBatch(k, true);
		const s = __debug.stats();
		expect(s.gNext).toBe(4);
		expect(s.wNext).toBe(8);
		expect(s.certNext).toBe(0);
		expect(s.seqCounter).toBe(1);
		expect(s.liveSlotMask).toBe(0);
		expect(s.loggedAtomCount).toBe(0);
		expect(s.writeMode).toBe('DIRECT');
		expect(s.overlayEpoch).toBeGreaterThan(epochBefore); // cross-era invalidator
		expect(s.eraFloor).toBe(s.walkCounter); // all marks stale in O(1)
		__debug.verify();
	});

	it('walk-counter safety valve: forced past 2^30, the idle reset zeroes stamps', () => {
		const a = new Atom({ state: 0 });
		const c = new Computed({ fn: () => a.state + 1 });
		expect(c.state).toBe(1);
		__debug.forceCounters({ walkCounter: (1 << 30) + 5 });
		const k = fork.openBatch(true);
		fork.inBatch(k, () => a.set(1));
		fork.retireBatch(k, true); // quiescence runs the valve
		const s = __debug.stats();
		expect(s.walkCounter).toBe(0);
		expect(s.eraFloor).toBe(0);
		// The engine still works in the new era.
		const k2 = fork.openBatch(true);
		fork.inBatch(k2, () => a.set(9));
		expect(__debug.readInWorld(c, { kind: 'writer', token: k2 })).toBe(10);
		expect(__debug.committed(() => c.state)).toBe(2);
		fork.retireBatch(k2, true);
		expect(c.state).toBe(10);
		__debug.verify();
	});
});
