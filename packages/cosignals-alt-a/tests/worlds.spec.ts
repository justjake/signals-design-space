import { describe, expect, it } from 'vitest';
import { createCosignalEngine } from '../src/engine';
import { createForkDouble } from '../src/fork-double';

// M3 — worlds: visibility (§10.2), the rebase walkthrough (§10.7), world
// memos and certificates (§10.5), retirement/absorption (§9.5), truncation
// re-notification (resolution 4), sweep (§9.6), quiescence + eras (§9.7).

function activated() {
	const e = createCosignalEngine();
	const fork = createForkDouble();
	e.attachFork(fork);
	fork.registerRoot('root');
	return { e, fork };
}

describe('M3 visibility rule (§10.2)', () => {
	it('pass world: lane filter + pin, both clauses', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const t1 = fork.openBatch('deferred');
		const t2 = fork.openBatch('deferred');
		t1.run(() => a.set(1)); // seq s1, batch T1
		t2.run(() => a.set(2)); // seq s2, batch T2

		// Pass including only T1: sees T1's write, not T2's.
		let pass = fork.startPass('root', { include: [t1] });
		expect(a.state).toBe(1);
		pass.end();

		// Pass including both: replay in seq order → 2.
		pass = fork.startPass('root', { include: [t1, t2] });
		expect(a.state).toBe(2);
		pass.end();

		// Pass including T1; T2 retires DURING the pass (stamp > pin): the
		// pass must keep reading what it started with (clause 1 keys on
		// retire time, not write time).
		pass = fork.startPass('root', { include: [t1] });
		expect(a.state).toBe(1);
		pass.yield();
		t2.retire();
		pass.resume();
		expect(a.state).toBe(1); // T2's retirement is invisible to this pass
		pass.end();

		// A NEW pass sees T2's entry via clause 1 (retired before its pin).
		pass = fork.startPass('root', { include: [t1] });
		expect(a.state).toBe(2); // base 0 → T1 SET 1 → T2 SET 2 (retired ≤ pin)
		pass.end();
		t1.retire();
		e.debug.verify();
	});

	it('writes arriving during a pass are hidden from it (SEQ > pin)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(1));
		const pass = fork.startPass('root', { include: [t] });
		expect(a.state).toBe(1);
		pass.yield();
		t.run(() => a.set(2)); // same batch, after the pin
		pass.resume();
		expect(a.state).toBe(1); // included batch, but SEQ > pin
		pass.end();
		t.retire();
		e.debug.verify();
	});

	it('yield gaps read AMBIENT (W0, drafts hidden); the resumed pass still reads its pinned world (§10.1)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(1));
		const pass = fork.startPass('root'); // does NOT include t
		expect(a.state).toBe(0); // pass world excludes the pending batch
		pass.yield();
		// ALT-FAMILY AMBIENT RULE: gap code reads W0 — the pending deferred
		// draft stays hidden; Wn is the explicit selector read.
		expect(a.state).toBe(0);
		expect(e.debug.readWorld(a, { kind: 'newest' })).toBe(1);
		a.set(50); // urgent write from a "handler" in the gap: legal
		pass.resume();
		expect(a.state).toBe(0); // pin: the urgent write is after the pin
		pass.end();
		expect(a.state).toBe(50);
		t.retire();
		fork.closeEvent();
		e.debug.verify();
	});

	it('writes while render is executing throw (§10.8)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const pass = fork.startPass('root');
		expect(() => a.set(1)).toThrow(/render/);
		pass.end();
	});
});

describe('M3 rebase walkthrough (§10.7)', () => {
	it('functional updates rebase exactly like React updater queues', () => {
		const { e, fork } = activated();
		const a = e.atom(1);
		const t = fork.openBatch('deferred');
		t.run(() => a.update((x) => x + 1)); // e1: deferred, unapplied
		a.update((x) => x * 2); // e2: urgent, applied
		const u = fork.currentEventBatch()!;

		// Kernel value (W0) = base + applied = 1*2 = 2.
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(2);

		// Urgent render (includes U, not T): 1*2 = 2 — transition invisible.
		let pass = fork.startPass('root', { include: [u] });
		expect(a.state).toBe(2);
		pass.end();
		u.retire(); // absorption fold = 2 — unchanged, no-op

		// Transition render (includes T): (1+1)*2 = 4 — lands ON TOP of the
		// urgent change; the urgent updater was never dropped or pre-evaluated.
		pass = fork.startPass('root', { include: [t] });
		expect(a.state).toBe(4);
		pass.end();

		t.retire(); // fold = (1+1)*2 = 4; kernel moves 2 → 4
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(4);
		expect(e.readCommitted(a)).toBe(4);
		expect(e.debug.quiescent()).toBe(true); // sweep + quiescence
		e.debug.verify();
	});
});

describe('M3 world memos and certificates (§10.5)', () => {
	it('a marked computed evaluates at most once per pass world', () => {
		const { e, fork } = activated();
		const a = e.atom(1);
		let evals = 0;
		const c = e.computed(() => {
			++evals;
			return a.state * 10;
		});
		expect(c.state).toBe(10);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(2)); // marks the cone
		const before = evals;
		const pass = fork.startPass('root', { include: [t] });
		expect(c.state).toBe(20);
		expect(c.state).toBe(20);
		expect(c.state).toBe(20);
		expect(evals).toBe(before + 1); // one overlay evaluation, memo-served
		pass.end();
		// A restarted pass misses the old memos by key and re-evaluates.
		const pass2 = fork.startPass('root', { include: [t] });
		expect(c.state).toBe(20);
		expect(evals).toBe(before + 2);
		pass2.end();
		t.retire();
		e.debug.verify();
	});

	it('newest-world memos re-validate via certificates on appends', () => {
		const { e, fork } = activated();
		const a = e.atom(1);
		let evals = 0;
		const c = e.computed(() => {
			++evals;
			return a.state * 10;
		});
		expect(c.state).toBe(10);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(2)); // unapplied > 0 → NEWEST is world-sensitive
		const n0 = evals;
		// Explicit Wn selector reads (ambient .state is W0 in the alt family).
		expect(e.debug.readWorld(c, { kind: 'newest' })).toBe(20); // overlay evaluation, memoized (key 0)
		expect(e.debug.readWorld(c, { kind: 'newest' })).toBe(20);
		expect(evals).toBe(n0 + 1);
		t.run(() => a.set(3)); // append moves the tail seq → certificate mismatch
		expect(e.debug.readWorld(c, { kind: 'newest' })).toBe(30); // re-evaluates
		expect(evals).toBe(n0 + 2);
		t.retire();
		e.debug.verify();
	});

	it('nested certificate flattening: a parent memo is invalidated by grandchild-source appends, including through child memo hits', () => {
		const { e, fork } = activated();
		const a = e.atom(1);
		const child = e.computed(() => a.state + 1);
		const parent = e.computed(() => child.state * 100);
		expect(parent.state).toBe(200);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(2));
		// Evaluate child first so the parent's evaluation HITS the child memo
		// (the cert-copy path, not just the nested-frame path).
		expect(e.debug.readWorld(child, { kind: 'writer', token: t.token })).toBe(3);
		expect(e.debug.readWorld(parent, { kind: 'writer', token: t.token })).toBe(300);
		// Grandchild-source append: parent must re-answer, not serve the memo.
		t.run(() => a.set(9));
		expect(e.debug.readWorld(parent, { kind: 'writer', token: t.token })).toBe(1000);
		t.retire();
		e.debug.verify();
	});

	it('epoch bumps invalidate memos on retirement without any tail movement', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const b = e.atom(100);
		const c = e.computed(() => a.state + b.state);
		expect(c.state).toBe(100);
		const t1 = fork.openBatch('deferred');
		const t2 = fork.openBatch('deferred');
		t1.run(() => a.set(1));
		t2.run(() => b.set(200));
		// t2's writer world: a untouched by t2 → 0(+applied) ... = 0 + 200 = 200.
		expect(e.debug.readWorld(c, { kind: 'writer', token: t2.token })).toBe(200);
		// t1 retires: its entry becomes visible in t2's writer world — but no
		// tape tail moved. Only the epoch bump can invalidate t2's memo.
		t1.retire();
		expect(e.debug.readWorld(c, { kind: 'writer', token: t2.token })).toBe(201);
		t2.retire();
		e.debug.verify();
	});
});

describe('M3 retirement and absorption (§9.5)', () => {
	it('absorbs committed=false batches identically (writes are real)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(5));
		t.retire(false); // store-only batch, never produced React work
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(5);
		expect(e.readCommitted(a)).toBe(5);
		expect(e.debug.quiescent()).toBe(true);
	});

	it('a W0-no-op retirement still re-notifies other pending worlds (coordinator pitfall)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		e.watch(a);
		a.set(5); // urgent: W0 = 5
		const u = fork.currentEventBatch()!;
		const t2 = fork.openBatch('deferred');
		t2.run(() => a.set(7)); // T2's world: 7
		const t1 = fork.openBatch('deferred');
		t1.run(() => a.set(5)); // equal to W0; T1's world: base0,U5,T2(x),T1 5 → 5
		e.debug.takeBroadcasts();
		u.retire(); // hmm: U's fold is a no-op for W0 (already applied)...
		t1.retire(); // W0 fold: base 0, U5(retired), T2 pending excluded, T1 5 → 5 — W0 unchanged.
		// But T2's writer world shifted: before, base0→U5→T2 7→(T1 unretired
		// invisible) = 7; after T1 retired: base0→U5→T2 7→T1 5 = 5.
		const evs = e.debug.takeBroadcasts();
		expect(evs.map((x) => [x.token, x.value])).toContainEqual([t2.token, 5]);
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(5);
		t2.retire();
		e.debug.verify();
	});

	it('absorption flushes core effects once per retirement', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const b = e.atom(0);
		let runs = 0;
		e.effect(() => {
			a.state;
			b.state;
			++runs;
		});
		runs = 0;
		const t = fork.openBatch('deferred');
		t.run(() => {
			a.set(1);
			b.set(2);
		});
		expect(runs).toBe(0); // deferred writes queue nothing
		t.retire();
		expect(runs).toBe(1); // one flush for the whole absorption
		e.debug.verify();
	});
});

describe('M3 truncation (§9.6 + resolution 4)', () => {
	it('truncation discards pending entries and re-notifies the batch lane', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const c = e.computed(() => a.state * 10);
		expect(c.state).toBe(0);
		e.watch(c);
		e.debug.takeBroadcasts();
		const t = fork.openBatch('deferred');
		t.run(() => a.set(5));
		const first = e.debug.takeBroadcasts();
		expect(first.map((x) => [x.token, x.value])).toContainEqual([t.token, 50]);
		e.truncateBatch(t.token); // optimistic rollback
		// Resolution 4: the rolled-back lane is re-notified with the reverted
		// value — otherwise its components stay stale until an unrelated drain.
		const evs = e.debug.takeBroadcasts();
		expect(evs.map((x) => [x.token, x.value])).toContainEqual([t.token, 0]);
		expect(e.debug.readWorld(a, { kind: 'writer', token: t.token })).toBe(0);
		expect(a.state).toBe(0);
		t.retire(); // retiring the emptied batch is a no-op fold
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(0);
		e.debug.verify();
	});
});

describe('M3 sweep and quiescence (§9.6, §9.7)', () => {
	it('reaches zero residue after the full lifecycle and starts a new era', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const c = e.computed(() => a.state + 1);
		expect(c.state).toBe(1);
		const eraBefore = e.debug.era();
		const epochBefore = e.debug.epoch();
		const t = fork.openBatch('deferred');
		t.run(() => a.set(5));
		const pass = fork.startPass('root', { include: [t] });
		expect(c.state).toBe(6);
		pass.end();
		t.retire();
		expect(e.debug.quiescent()).toBe(true);
		expect(e.debug.planeResidue()).toEqual({ g: true, w: true });
		expect(e.debug.seqCounter()).toBe(1); // seq restart
		expect(e.debug.era()).toBe(eraBefore + 1);
		expect(e.debug.epoch()).toBeGreaterThan(epochBefore); // cross-era invalidator
		expect(e.debug.isLogged(a)).toBe(false);
		expect(e.debug.isMarked(c)).toBe(false); // era floor rose in O(1)
		// The gate stays armed: the next era works identically.
		const t2 = fork.openBatch('deferred');
		t2.run(() => a.set(50));
		expect(e.debug.readWorld(a, { kind: 'writer', token: t2.token })).toBe(50);
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(5);
		t2.retire();
		expect(e.debug.quiescent()).toBe(true);
		e.debug.verify();
	});

	it('era-crossing memos cannot revive on coincidentally equal seqs (§9.7 epoch bump)', () => {
		const { e, fork } = activated();
		const a = e.atom(1);
		let evals = 0;
		const c = e.computed(() => {
			++evals;
			return a.state * 10;
		});
		expect(c.state).toBe(10);
		// Era 1: identical tape shape to era 2 (same seq values will recur).
		const t1 = fork.openBatch('deferred');
		t1.run(() => a.set(2));
		expect(e.debug.readWorld(c, { kind: 'newest' })).toBe(20); // newest overlay memo recorded with era-1 seqs
		const n1 = evals;
		t1.retire();
		expect(e.debug.quiescent()).toBe(true);
		// Era 2: craft the same seq pattern (seqCounter restarted at 1).
		const t2 = fork.openBatch('deferred');
		t2.run(() => a.set(3)); // same tail seq values as era 1's tape
		expect(e.debug.readWorld(c, { kind: 'newest' })).toBe(30); // MUST re-evaluate — a revived memo would say 20
		expect(evals).toBeGreaterThan(n1);
		t2.retire();
		e.debug.verify();
	});

	it('walk-counter safety valve resets stamps at quiescence (§9.7)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const c = e.computed(() => a.state + 1);
		expect(c.state).toBe(1);
		e.debug.forceWalkCounter((1 << 30) + 5);
		const t = fork.openBatch('deferred');
		t.run(() => a.set(1));
		expect(e.debug.isMarked(c)).toBe(true);
		t.retire();
		expect(e.debug.quiescent()).toBe(true);
		expect(e.debug.walkCounter()).toBe(0); // valve fired
		expect(e.debug.eraFloor()).toBe(0);
		expect(e.debug.isMarked(c)).toBe(false);
		// New era still marks correctly from zero.
		const t2 = fork.openBatch('deferred');
		t2.run(() => a.set(2));
		expect(e.debug.isMarked(c)).toBe(true);
		expect(e.debug.readWorld(c, { kind: 'writer', token: t2.token })).toBe(3);
		t2.retire();
		e.debug.verify();
	});

	it('forced seq-counter values survive an era and reset at quiescence (§17.2 pinned wrap family)', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		e.debug.forceSeqCounter(1 << 30); // pathologically large tickets
		const t = fork.openBatch('deferred');
		t.run(() => a.set(1));
		const pass = fork.startPass('root', { include: [t] });
		expect(a.state).toBe(1);
		pass.end();
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(0);
		t.retire();
		expect(e.debug.quiescent()).toBe(true);
		expect(e.debug.seqCounter()).toBe(1); // quiescence restarts the counter
		const t2 = fork.openBatch('deferred');
		t2.run(() => a.set(2));
		expect(e.debug.readWorld(a, { kind: 'writer', token: t2.token })).toBe(2);
		t2.retire();
		e.debug.verify();
	});

	it('sweep folds dead entries under an open pin without disturbing the pass', () => {
		const { e, fork } = activated();
		const a = e.atom(0);
		const t1 = fork.openBatch('deferred');
		t1.run(() => a.set(1));
		t1.retire(); // committed: 1
		const pass = fork.startPass('root'); // pin AFTER retirement: sees 1
		expect(a.state).toBe(1);
		pass.yield();
		const t2 = fork.openBatch('deferred');
		t2.run(() => a.set(2));
		t2.retire(); // retires after the pin — must stay unfolded for the pass
		expect(e.debug.readWorld(a, { kind: 'w0' })).toBe(2);
		pass.resume();
		expect(a.state).toBe(1); // the pass still reads its pinned world
		pass.end();
		expect(a.state).toBe(2);
		expect(e.debug.quiescent()).toBe(true);
		e.debug.verify();
	});
});
