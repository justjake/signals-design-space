import { describe, expect, it } from 'vitest';
import { createCosignalEngine } from '../src/engine';
import { createForkDouble } from '../src/fork-double';

// M2 — tape mechanics: monotonic activation (§9.1), slot interning (§9.2),
// appendLog + equality/receipt + coalescing (§9.3), applied/unapplied (§9.4),
// notify walk and token-grouped drain (§9.8), driven by the fork double.

function setup() {
	const e = createCosignalEngine();
	const fork = createForkDouble();
	e.attachFork(fork);
	return { e, fork };
}

function activated() {
	const s = setup();
	s.fork.registerRoot('root');
	return s;
}

describe('M2 write gate: monotonic activation (§9.1)', () => {
	it('is DIRECT until the first root registers, LOGGED permanently after', () => {
		const { e, fork } = setup();
		const a = e.atom(0);
		expect(e.debug.mode()).toBe('DIRECT');
		a.set(1); // pre-activation write: pure kernel, no tape
		expect(e.debug.isLogged(a)).toBe(false);
		expect(a.state).toBe(1);

		fork.registerRoot('root');
		expect(e.debug.mode()).toBe('LOGGED');
		a.set(2);
		expect(e.debug.isLogged(a)).toBe(true); // every write is logged now
		expect(a.state).toBe(2);

		// Reach quiescence: retire the bare-write event batch, sweep.
		fork.closeEvent();
		expect(e.debug.quiescent()).toBe(true);
		expect(e.debug.isLogged(a)).toBe(false); // tape swept
		// The gate does NOT revert at quiescence (monotonic).
		expect(e.debug.mode()).toBe('LOGGED');
		a.set(3);
		expect(e.debug.isLogged(a)).toBe(true);
		fork.closeEvent();
		e.debug.verify();
	});

	it('second root registration is a no-op for the gate', () => {
		const { e, fork } = setup();
		fork.registerRoot('a');
		fork.registerRoot('b');
		expect(e.debug.mode()).toBe('LOGGED');
	});

	it('pre-activation writes are visible to every later pass (committed history)', () => {
		const { e, fork } = setup();
		const a = e.atom(0);
		a.set(42); // before activation: DIRECT
		fork.registerRoot('root');
		const pass = fork.startPass('root');
		expect(a.state).toBe(42); // RENDER read
		pass.end();
		expect(e.readCommitted(a)).toBe(42);
	});
});

describe('M2 applied vs unapplied (§9.4)', () => {
	it('urgent writes are logged AND applied; deferred writes are log-only', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		let effectSeen: number[] = [];
		e.effect(() => {
			effectSeen.push(a.state);
		});
		effectSeen = [];

		a.set(1); // bare = urgent
		expect(effectSeen).toEqual([1]); // kernel effects ran
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(1);
		expect(e.debug.unappliedEntries()).toBe(0);

		const t = fork.openBatch('deferred');
		t.run(() => a.set(5));
		expect(e.debug.unappliedEntries()).toBe(1);
		expect(effectSeen).toEqual([1]); // no kernel effect for deferred write
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(1); // canonical untouched
		// ALT-FAMILY AMBIENT RULE: the deferred draft is hidden from ambient
		// reads (W0); visible via the explicit Wn selector and in-scope.
		expect(a.state).toBe(1);
		expect(e.debug.readWorld(a, { kind: 'newest' })).toBe(5);
		t.run(() => {
			expect(a.state).toBe(5); // read-your-own-draft
		});
		expect(e.readCommitted(a)).toBe(0); // nothing retired yet... event batch pending
		fork.closeEvent(); // retire the urgent event batch → its entry retires
		expect(e.readCommitted(a)).toBe(1); // committed now includes the urgent write
		t.retire();
		expect(e.readCommitted(a)).toBe(5);
		expect(effectSeen).toEqual([1, 5]); // absorption queued core effects
		e.debug.verify();
	});

	it('deferred update(fn) stores the function and replays per world (§12.1)', () => {
		const { e, fork } = activated();
		const a = e.atom(10);
		const t = fork.openBatch('deferred');
		t.run(() => a.update((x) => x + 1));
		expect(a.state).toBe(10); // ambient = W0: the deferred draft is hidden
		expect(e.debug.readWorld(a, { kind: 'newest' })).toBe(11); // Wn replays the fn
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(10); // canonical untouched
		a.set(100); // urgent SET lands after the update in seq order
		expect(a.state).toBe(100); // newest fold: 10 → +1 → SET 100
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(100); // applied
		t.retire();
		// The urgent event batch is still unretired: committed excludes its
		// applied entry (§10.2) — only the retired UPDATE is visible.
		expect(e.readCommitted(a)).toBe(11);
		fork.closeEvent();
		expect(e.readCommitted(a)).toBe(100);
		e.debug.verify();
	});
});

describe('M2 equality and receipts (§9.3)', () => {
	it('drops equal writes only while the atom has no tape', () => {
		const { e, fork } = activated();
		const a = e.atom(7);
		a.set(7); // tapeless equal write → dropped entirely
		expect(e.debug.isLogged(a)).toBe(false);

		a.set(8); // creates the tape
		expect(e.debug.isLogged(a)).toBe(true);
		fork.closeEvent();
		e.debug.verify();
	});

	it('equal urgent SET over a pending transition still appends (the receipt)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(1)); // pending transition: a = 1 in T's world
		a.set(1); // urgent write, equal to the NEWEST value — must NOT be dropped
		const u = fork.currentEventBatch()!;

		// The urgent-only world (a pass excluding T) must read 1 — only the
		// receipt makes that possible.
		const pass = fork.startPass('root', { include: [u] });
		expect(a.state).toBe(1);
		pass.end();
		// And W0 (canonical) is 1 because the urgent write applied.
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(1);
		// T's world: base 0, T SET 1, urgent SET 1 → 1.
		expect(e.debug.readWorld(a, { kind: 'writer', token: t.token })).toBe(1);
		fork.closeEvent();
		t.retire();
		expect(a.state).toBe(1);
		e.debug.verify();
	});

	it('pass pinned before the tape reads the base snapshot (tear prevention, §10.3)', () => {
		const { e, fork } = activated();
		const a = e.atom(3);
		a.set(4); // tape exists with applied entry
		fork.closeEvent(); // retired; entry may fold, but keep going
		const pass = fork.startPass('root'); // pin now
		// A NEW urgent write lands after the pin (from a yield gap).
		pass.yield();
		a.set(9);
		pass.resume();
		expect(a.state).toBe(4); // the pass keeps reading its pinned world
		pass.end();
		expect(a.state).toBe(9);
		fork.closeEvent();
		e.debug.verify();
	});
});

describe('M2 marks (§9.3 tape creation, §8.7.3 repair)', () => {
	it('tape creation marks the downstream cone even for urgent writes', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const c = e.computed(() => a.state + 1);
		expect(c.state).toBe(1); // canonical evaluation links a → c
		expect(e.debug.isMarked(c)).toBe(false);
		a.set(5); // urgent, tape-creating
		expect(e.debug.isMarked(c)).toBe(true);
		// flushSync one-computed-downstream variant: a COMMITTED read of c must
		// exclude the applied-but-unretired entry.
		expect(e.readCommitted(c)).toBe(1);
		expect(c.state).toBe(6); // newest
		fork.closeEvent();
		expect(e.readCommitted(c)).toBe(6);
		e.debug.verify();
	});

	it('mark repair: a canonical re-evaluation taking a new branch into a logged atom marks the consumer (post-eval re-check, §10.4)', () => {
		const { e, fork } = activated();
		const flag = e.atom(false);
		const x = e.atom(0);
		const y = e.atom(100);
		const c = e.computed(() => (flag.state ? x.state : y.state));
		expect(c.state).toBe(100); // canonical deps: flag, y
		// A deferred batch writes x — c has no canonical edge to x, so c stays unmarked.
		const t = fork.openBatch('deferred');
		t.run(() => x.set(7));
		expect(e.debug.isMarked(c)).toBe(false);
		// Urgent flip of flag: canonical re-evaluation takes the x branch,
		// linkInsert repairs the mark mid-evaluation, and the post-eval
		// re-check must answer the NEWEST world (which includes x=7).
		flag.set(true);
		// The explicit Wn read triggers the canonical re-evaluation, the
		// linkInsert repair, and the post-eval re-check — answering Wn.
		expect(e.debug.readWorld(c, { kind: 'newest' })).toBe(7);
		expect(e.debug.isMarked(c)).toBe(true);
		// Ambient = W0: x's deferred write is unapplied → 0.
		expect(a_state(c)).toBe(0);
		expect(e.debug.readWorld(c, { kind: 'w0' })).toBe(0);
		fork.closeEvent();
		t.retire();
		e.debug.verify();

		function a_state(h: { state: unknown }): unknown {
			return h.state;
		}
	});
});

describe('M2 slots (§9.2)', () => {
	it('interns tokens, recycles slots after retirement + sweep', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const t1 = fork.openBatch('deferred');
		t1.run(() => a.set(1));
		expect(e.debug.liveSlotMask()).not.toBe(0);
		t1.retire();
		fork.closeEvent();
		expect(e.debug.quiescent()).toBe(true);
		expect(e.debug.liveSlotMask()).toBe(0); // slot released after sweep
		// A new batch can claim the slot; old entries are gone.
		const t2 = fork.openBatch('deferred');
		t2.run(() => a.set(2));
		expect(a.state).toBe(1); // ambient = W0; the new draft is hidden
		expect(e.debug.readWorld(a, { kind: 'newest' })).toBe(2);
		t2.retire();
		expect(e.debug.quiescent()).toBe(true);
		e.debug.verify();
	});

	it('slot exhaustion degrades writes toward urgent instead of crashing (§9.2 fallback)', () => {
		// React holds ≤31 live tokens, but the ENGINE's 32 slots can all be
		// occupied when retired batches' entries are pinned unswept by an open
		// pass. A fresh token then finds no free slot → pseudo fallback.
		const { e, fork } = activated();
		const a = e.atom(0);
		a.set(-1); // urgent event batch → slot 1
		const batches = [];
		for (let i = 0; i < 30; i++) {
			const b = fork.openBatch('deferred');
			b.run(() => a.update((x) => x - 1)); // 30 more slots (31 total)
			batches.push(b);
		}
		const pass = fork.startPass('root'); // pin BEFORE retirement
		pass.yield(); // gap: writes/retires below are legal and stay unswept
		fork.closeEvent(); // retire the event batch — entries pinned, slot held
		for (const b of batches) {
			b.retire(); // 31 slots now retired-but-unswept
		}
		const t32 = fork.openBatch('deferred');
		t32.run(() => a.set(500)); // takes the 32nd (last free) slot
		const t33 = fork.openBatch('deferred');
		let ok = true;
		try {
			t33.run(() => a.set(999)); // no slot left → pseudo fallback
		} catch {
			ok = false;
		}
		expect(ok).toBe(true);
		expect(a.state).toBe(999); // newest sees it (always-included)
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(999); // degraded to applied
		pass.resume();
		pass.end();
		t32.retire();
		t33.retire();
		expect(e.debug.quiescent()).toBe(true);
		e.debug.verify();
	});
});

describe('M2 coalescing (§9.3)', () => {
	it('same-batch SETs coalesce in place when no pass is open', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const t = fork.openBatch('deferred');
		t.run(() => {
			for (let i = 1; i <= 100; i++) {
				a.set(i);
			}
		});
		expect(a.state).toBe(0); // ambient = W0; coalesced draft hidden
		expect(e.debug.readWorld(a, { kind: 'writer', token: t.token })).toBe(100);
		t.retire();
		expect(e.readCommitted(a)).toBe(100);
		fork.closeEvent();
		e.debug.verify();
	});

	it('coalescing is blocked while a pass is open (a pinned pass may sit between writes)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(1));
		const pass = fork.startPass('root', { include: [t] });
		expect(a.state).toBe(1); // pass world sees the first write
		pass.yield();
		t.run(() => a.set(2)); // in the gap; must NOT rewrite entry 1 in place
		pass.resume();
		expect(a.state).toBe(1); // pinned: still the first write only
		pass.end();
		expect(e.debug.readWorld(a, { kind: 'writer', token: t.token })).toBe(2);
		t.retire();
		fork.closeEvent();
		e.debug.verify();
	});

	it('deferred update-chains compose past the threshold and still fold correctly', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const t = fork.openBatch('deferred');
		t.run(() => {
			for (let i = 0; i < 20; i++) {
				a.update((x) => x + 1);
			}
		});
		expect(e.debug.readWorld(a, { kind: 'writer', token: t.token })).toBe(20);
		t.retire();
		expect(e.readCommitted(a)).toBe(20);
		fork.closeEvent();
		e.debug.verify();
	});
});

describe('M2 deferred-write notification (§9.8)', () => {
	it('notifies watchers on every deferred write, in the writer lane (entangled)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		e.watch(a);
		e.debug.takeBroadcasts();
		const t = fork.openBatch('deferred');
		t.run(() => a.set(5));
		const b = e.debug.takeBroadcasts();
		expect(b).toHaveLength(1);
		expect(b[0].token).toBe(t.token);
		expect(b[0].value).toBe(5);
		expect(b[0].forkBatchDuringCallback).toBe(t.token); // lane parity via runInBatch
		t.retire();
		e.debug.verify();
	});

	it('two-batch re-notify: a second batch writing an already-marked region still reaches watchers', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const c = e.computed(() => a.state * 10);
		expect(c.state).toBe(0);
		e.watch(c);
		e.debug.takeBroadcasts();

		const t1 = fork.openBatch('deferred');
		t1.run(() => a.set(1));
		const b1 = e.debug.takeBroadcasts();
		expect(b1.map((x) => [x.token, x.value])).toContainEqual([t1.token, 10]);

		const t2 = fork.openBatch('deferred');
		t2.run(() => a.set(2)); // region already marked — walk must still run
		const b2 = e.debug.takeBroadcasts();
		expect(b2.map((x) => [x.token, x.value])).toContainEqual([t2.token, 20]);
		t1.retire();
		t2.retire();
		e.debug.verify();
	});

	it('same-batch second write after a cutoff-suppressed first write notifies', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const c = e.computed(() => Math.abs(a.state));
		expect(c.state).toBe(0);
		e.watch(c);
		e.debug.takeBroadcasts();
		const t = fork.openBatch('deferred');
		t.run(() => a.set(-0)); // |−0| = 0 → cutoff suppresses (Object.is on fold keeps 0)
		const b1 = e.debug.takeBroadcasts();
		expect(b1).toHaveLength(0);
		t.run(() => a.set(-3)); // second write, same batch: c would be 3
		const b2 = e.debug.takeBroadcasts();
		expect(b2.map((x) => [x.token, x.value])).toContainEqual([t.token, 3]);
		t.retire();
		e.debug.verify();
	});

	it('grouped drain: batch() defers walks to close; setStates land in each write batch lane', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const b = e.atom(0);
		e.watch(a);
		e.watch(b);
		e.debug.takeBroadcasts();
		const t = fork.openBatch('deferred');
		e.batch(() => {
			a.set(1); // urgent
			t.run(() => b.set(2)); // deferred — its scope closes before the drain
			expect(e.debug.takeBroadcasts()).toHaveLength(0); // nothing drained yet
		});
		const evs = e.debug.takeBroadcasts();
		const byToken = new Map(evs.map((ev) => [ev.token, ev]));
		expect(byToken.get(0)?.value).toBe(1); // urgent lane
		expect(byToken.get(t.token)?.value).toBe(2);
		expect(byToken.get(t.token)?.forkBatchDuringCallback).toBe(t.token); // entangled after scope closed
		t.retire();
		fork.closeEvent();
		e.debug.verify();
	});

	it('equal-value urgent write onto a tape still shifts pending worlds (resolution 2)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		e.watch(a);
		e.debug.takeBroadcasts();
		const t = fork.openBatch('deferred');
		t.run(() => a.set(5)); // T's world: 5
		expect(e.debug.takeBroadcasts().map((x) => [x.token, x.value])).toContainEqual([t.token, 5]);
		a.set(0); // urgent, equal to W0 (0) — kernel never propagates...
		// ...but T's fold is now base 0, T SET 5, urgent SET 0 → 0: T's world reverted.
		const evs = e.debug.takeBroadcasts();
		expect(evs.map((x) => [x.token, x.value])).toContainEqual([t.token, 0]);
		t.retire();
		fork.closeEvent();
		e.debug.verify();
	});
});
