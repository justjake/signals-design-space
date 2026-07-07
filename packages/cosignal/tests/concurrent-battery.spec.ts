// TWIN RUN — this spec runs against the reference model (`cosignal-oracle`)
// AND the CONCURRENT engine at once: ./helpers.js here is the twin driver (model
// + engine fan-out; every read is parity-asserted; selfCheck compares
// events/snapshots and runs the invariant battery on BOTH sides). Kept in
// lockstep with the reference model's own tests/battery.spec.ts.
// One deliberate deviation: case 14's "render-phase writes throw" drives the
// ENGINE directly — a fan-out write inside one side's evaluation would corrupt
// the other side by construction (the model half of that case runs in the
// reference model's own suite).
import { __newBridgeForTest } from '../src/concurrent.js';
/**
 * The 17-case acceptance battery of the behavioral contract, as
 * deterministic named tests asserting the required outcomes at model level.
 * Aspects that need the real patched React build are listed in
 * SKIPPED-FOR-FORK-SUITE.md alongside the reference model's own suite.
 */
import { describe, expect, it } from 'vitest';
import { commitAndRetire, concurrent, mountCommitted, openRender, selfCheck, set, update } from './helpers.js';

describe('case 1 — world-divergent dependency (the killer; family)', () => {
	function setup() {
		const m = concurrent();
		const flag = m.atom('flag', 0);
		const a = m.atom('a', 0);
		const b = m.atom('b', 0);
		const c = m.computed('c', (read) => (read(flag) ? read(a) : read(b)));
		const w = mountCommitted(m, 'A', c, 'W');
		return { m, flag, a, b, c, w };
	}

	it('core walk: k-world c=1 via the real k-dep; delivery in k lane; committed intact', () => {
		const { m, flag, a, c, w } = setup();
		const k = m.openBatch('deferred');
		m.write(k.id, flag, set(1)); // step 1
		expect(m.eventsOfType('delivery').filter((e) => e.watcher === 'W' && e.batch === k.id)).toHaveLength(1);
		const pk = openRender(m, 'A', [k]); // step 2: k-world read caches nothing in the model, but records the real dep a→c
		expect(m.renderValue(c, pk)).toBe(0); // flag=1 → a-path, a in-world 0
		m.write(k.id, a, set(1)); // step 3: post-pin write
		// render-aware suppression: bit set, but pk is open with pin < seq → deliver anyway
		const deliveries = m.eventsOfType('delivery').filter((e) => e.watcher === 'W' && e.batch === k.id);
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1]!.mode).toBe('interleaved');
		expect(m.renderValue(c, pk)).toBe(0); // pinned world never drifts (s2 > pin)
		m.renderEnd(pk.id, 'discard');
		const pk2 = openRender(m, 'A', [k]); // step 4: the follow-up render at a fresh pin
		expect(m.renderValue(c, pk2)).toBe(1); // ✓ W renders 1 in k's lane before k commits
		expect(m.committedValue(c, 'A')).toBe(0); // step 5: committed still reads 0 via b
		m.renderEnd(pk2.id, 'commit');
		m.retire(k.id);
		expect(m.committedValue(c, 'A')).toBe(1);
		expect(w.lastRenderedValue).toBe(1);
		selfCheck(m);
	});

	it('V2: write to the committed-only dep b in k over-notifies but never mis-values', () => {
		const { m, flag, a, b, c } = setup();
		const k = m.openBatch('deferred');
		m.write(k.id, flag, set(1));
		m.write(k.id, a, set(1));
		m.write(k.id, b, set(9)); // k-world c takes the a-path; the walk still reaches W value-blind.
		// (W, k) is already armed and no render has started: the scheduled render will
		// fold a=1 and b=9, so dedup suppresses both follow-ups — a scheduling
		// decision, never an equality test on values.
		expect(m.eventsOfType('suppressed').filter((e) => e.watcher === 'W' && e.batch === k.id)).toHaveLength(2);
		const pk = openRender(m, 'A', [k]);
		expect(m.renderValue(c, pk)).toBe(1); // value unchanged by b in k's world
		m.renderEnd(pk.id, 'discard');
		selfCheck(m);
	});

	it('V4/V5: urgent writes; pending worlds include applied urgent state; pinned render never drifts', () => {
		const { m, flag, a, c } = setup();
		const k = m.openBatch('deferred');
		m.write(k.id, flag, set(1));
		m.write(k.id, a, set(1));
		const preU = openRender(m, 'B', [k]); // a yielded pre-U render
		m.renderYield(preU.id);
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(9));
		commitAndRetire(m, 'A', u);
		expect(m.renderValue(c, preU)).toBe(1); // retiredSeq > pin ⇒ excluded ✓ pinned world stable
		m.renderResume(preU.id);
		m.renderEnd(preU.id, 'discard');
		const pk2 = openRender(m, 'B', [k]); // post-restart render: folds a: {1,k} then {9, retired} by seq order
		expect(m.renderValue(c, pk2)).toBe(9);
		m.renderEnd(pk2.id, 'discard');
		selfCheck(m);
	});

	it('V6: slot reuse after k retires — tenancy orderings keep folds exact', () => {
		const { m, a, c } = setup();
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(1));
		const kSlot = m.idToBatch.get(k.id)!.slot!;
		const held = openRender(m, 'B', []); // a render that excludes k, pinned before k retires
		m.renderYield(held.id);
		m.retire(k.id); // slot releases immediately (no mask names it)
		expect(m.eventsOfType('slot-released').some((e) => e.batch === k.id)).toBe(true);
		const v = m.openBatch('deferred');
		m.write(v.id, a, set(2));
		expect(m.idToBatch.get(v.id)!.slot).toBe(kSlot); // recycled
		expect(m.slots[kSlot]!.writeClock).toBeGreaterThan(0); // fresh clock started from zero at claim
		// held render (pinned before k's retirement): excludes BOTH tenants
		expect(m.renderValue(a, held)).toBe(0);
		// a fresh render including V folds k via the retired clause then V via clause 2, in seq order
		const q = openRender(m, 'A', [v]);
		expect(m.renderValue(a, q)).toBe(2);
		expect(m.committedValue(c, 'A')).toBe(0); // c reads b committed; a=1 folded but flag never flipped
		expect(m.committedValue(a, 'A')).toBe(1); // k's retired write holds; V pending
		m.renderEnd(q.id, 'discard');
		m.renderResume(held.id);
		m.renderEnd(held.id, 'discard');
		selfCheck(m);
	});

	it('taint member: untracked reads never notify and fold in-world', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const b = m.atom('b', 0);
		const c = m.computed('c', (read, untracked) => (read(b) as number) + (untracked(a) as number) + 1);
		const d = m.computed('d', (read) => (read(c) as number) * 1);
		const w = mountCommitted(m, 'A', d, 'Wd');
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1)); // untracked dep: must NOT notify
		expect(m.eventsOfType('delivery').filter((e) => e.watcher === 'Wd')).toHaveLength(0);
		const u = m.openBatch('urgent');
		m.write(u.id, b, set(1)); // tracked dep: notifies
		expect(m.eventsOfType('delivery').filter((e) => e.watcher === 'Wd')).toHaveLength(1);
		const pu = openRender(m, 'A', [u]);
		expect(m.renderValue(c, pu)).toBe(2); // U's world folds untracked a IN-WORLD = 0 → c=1+1=2? b=1 + a(0) + 1 = 2 ✓
		m.renderEnd(pu.id, 'commit', { retireAtCommit: [u.id] });
		// sync render excluding T must see the T-free world through d (no leak of a=1)
		const sync = openRender(m, 'A', []);
		expect(m.renderValue(d, sync)).toBe(2);
		m.renderEnd(sync.id, 'commit');
		m.retire(t.id);
		expect(m.committedValue(d, 'A')).toBe(3);
		expect(w.lastRenderedValue).toBe(3); // reconcile drain corrected it
		selfCheck(m);
	});

	it('retention member: paused render across a foreign retirement (release rule at work)', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const n = m.computed('n', (read) => (read(a) as number) + 10);
		const ce = m.mountCoreEffect(n, 'core-n');
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(5)); // T holds a slot so P's mask is non-empty
		const p = openRender(m, 'B', [t]);
		m.renderYield(p.id);
		const u = m.openBatch('urgent'); // gap click
		m.write(u.id, a, set(1));
		expect(ce.lastValue).toBe(11); // core effects always observe the newest values — the core contract
		m.retire(u.id); // entries stamped; pin blocks compaction; slot releases immediately
		expect(m.eventsOfType('slot-released').some((e) => e.batch === u.id)).toBe(true);
		m.renderResume(p.id);
		expect(m.renderValue(n, p)).toBe(15); // clause 1 fails (rs > pin), clause 2 has only T: a=5 → 15; U invisible
		const uLog = m.idToNode.get(a.id);
		expect(uLog).toBeDefined();
		expect(a.log.length).toBeGreaterThan(0); // pin-blocked from compaction
		// later tenant V claims the freed slot and writes a=2: P still excludes it
		const v = m.openBatch('urgent');
		m.write(v.id, a, set(2));
		expect(m.renderValue(n, p)).toBe(15);
		// fresh render Q (mask {V}) folds U's retired entry then V's clause-2 entry, by global sequence
		const q = openRender(m, 'A', [v]);
		expect(m.renderValue(a, q)).toBe(2); // 1 (retired) replayed before 2 → 2, nothing double-applies
		m.renderEnd(q.id, 'discard');
		m.renderEnd(p.id, 'discard');
		selfCheck(m);
	});

	it('storm member: slot demand collapses to live + mask-retained; log entries all survive', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, update((x) => (x as number) + 100));
		const held = openRender(m, 'B', [t]);
		m.renderYield(held.id);
		for (let i = 1; i <= 40; i++) {
			const u = m.openBatch('urgent');
			m.write(u.id, a, set(i));
			commitAndRetire(m, 'A', u);
		}
		const inUse = m.slots.filter((s) => s.tenant !== undefined).length;
		expect(inUse).toBeLessThanOrEqual(3); // T plus the recycling urgent slot(s); never approaching 31
		expect(a.log.length).toBe(41); // pin 100-style retention: all log entries stay (held pin blocks compaction)
		expect(m.renderValue(a, held)).toBe(100); // held world: only T visible
		expect(m.committedValue(a, 'A')).toBe(40);
		m.renderResume(held.id);
		m.renderEnd(held.id, 'discard');
		m.retire(t.id);
		expect(m.committedValue(a, 'A')).toBe(40); // replay by sequence: +100 first, then the sets
		expect(a.log.length).toBe(0); // everything compacted once pins released
		selfCheck(m);
	});

	it('union-cycle member: per-world acyclic, union cyclic — walks terminate, evals fine', () => {
		const m = concurrent();
		const f = m.atom('f', 1);
		const a = m.atom('a', 7);
		const b = m.atom('b', 3);
		// f=1: x = a, y = x. f=0: y = b, x = y. Union has x→y and y→x.
		type R = (n: never) => unknown;
		const refs: { x?: unknown; y?: unknown } = {};
		const x = m.computed('x', (read) => (read(f) ? read(a) : read(refs.y as never)) as unknown);
		const y = m.computed('y', (read) => (read(f) ? read(refs.x as never) : read(b)) as unknown);
		refs.x = x;
		refs.y = y;
		void (undefined as unknown as R);
		expect(m.newestValue(x)).toBe(7);
		expect(m.newestValue(y)).toBe(7);
		const k = m.openBatch('deferred');
		m.write(k.id, f, set(0));
		const pk = openRender(m, 'A', [k]);
		expect(m.renderValue(x, pk)).toBe(3);
		expect(m.renderValue(y, pk)).toBe(3);
		m.write(k.id, a, set(8)); // delivery walk over the union graph terminates
		m.renderEnd(pk.id, 'discard');
		m.retire(k.id);
		selfCheck(m);
	});

	it('recreation member: changed deps mean a fresh node; evaluators never swap', () => {
		const m = concurrent();
		const a = m.atom('a', 1);
		const c1 = m.computed('c1', (read) => (read(a) as number) * 2);
		// a "deps change" recreates: same hook, new node with the new closure
		const c2 = m.computed('c2', (read) => (read(a) as number) * 10);
		expect(m.newestValue(c1)).toBe(2);
		expect(m.newestValue(c2)).toBe(10);
		expect(c1.fn).not.toBe(c2.fn); // no machinery anywhere swaps a live node's evaluator — it is immutable for the node's life
		selfCheck(m);
	});
});

describe('case 2 — flushSync excludes a pending default batch (why always-log)', () => {
	it('the excluding sync render sees BOTH old values; D folds later; watcher reconciles', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => (read(a) as number) + 10);
		const w = mountCommitted(m, 'A', c, 'W');
		const d = m.openBatch('default');
		m.write(d.id, a, set(1)); // ALWAYS logged — urgency never skips history
		expect(m.eventsOfType('write')).toHaveLength(1);
		expect(m.newestValue(a)).toBe(1); // writes apply to the kernel immediately
		const sync = openRender(m, 'A', []); // flushSync renders SyncLane only: D excluded
		expect(m.renderValue(a, sync)).toBe(0);
		expect(m.renderValue(c, sync)).toBe(10); // BOTH old — no torn frame
		// mount variant: a component mounting inside the flushSync render joins D's own lane
		const w2 = m.mountWatcher(sync.id, c, 'W2');
		m.renderEnd(sync.id, 'commit');
		expect(m.eventsOfType('mount-corrective').filter((e) => e.watcher === 'W2' && e.batch === d.id)).toHaveLength(1);
		commitAndRetire(m, 'A', d, [w2]);
		expect(m.committedValue(c, 'A')).toBe(11);
		expect(w.lastRenderedValue).toBe(11); // committed observers drained via D's touched list
		expect(w2.lastRenderedValue).toBe(11);
		selfCheck(m);
	});
});

describe('case 3 — rebase parity (React updater-queue arithmetic)', () => {
	it('replay-in-write-order over the pre-batch base: urgent commits 2, T commits 4 (never 3)', () => {
		const m = concurrent();
		const a = m.atom('a', 1);
		const t = m.openBatch('deferred');
		m.write(t.id, a, update((x) => (x as number) + 1)); // append (2 ≠ 1)
		expect(m.newestValue(a)).toBe(2);
		const u = m.openBatch('urgent');
		m.write(u.id, a, update((x) => (x as number) * 2)); // write log non-empty ⇒ always append
		expect(m.newestValue(a)).toBe(4);
		const pu = openRender(m, 'A', [u]);
		expect(m.renderValue(a, pu)).toBe(2); // base 1; T excluded; ×2 → 2
		m.renderEnd(pu.id, 'commit', { retireAtCommit: [u.id] });
		expect(m.committedValue(a, 'A')).toBe(2);
		expect(a.base).toBe(1); // compaction blocked: s1 (unretired) is a prefix hole — folding ×2 would commit 3
		expect(a.log).toHaveLength(2);
		const pt = openRender(m, 'A', [t]);
		expect(m.renderValue(a, pt)).toBe(4); // (1+1)×2 — mask{T} ∪ retired U, replayed by sequence
		m.renderEnd(pt.id, 'commit', { retireAtCommit: [t.id] });
		expect(m.committedValue(a, 'A')).toBe(4);
		selfCheck(m);
	});

	it('plain-set variant: +1 then set-5 commits 5, not 6', () => {
		const m = concurrent();
		const a = m.atom('a', 1);
		const t = m.openBatch('deferred');
		m.write(t.id, a, update((x) => (x as number) + 1));
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(5));
		const pu = openRender(m, 'A', [u]);
		expect(m.renderValue(a, pu)).toBe(5);
		m.renderEnd(pu.id, 'commit', { retireAtCommit: [u.id] });
		const pt = openRender(m, 'A', [t]);
		expect(m.renderValue(a, pt)).toBe(5); // +1 then set-5 → 5
		m.renderEnd(pt.id, 'commit', { retireAtCommit: [t.id] });
		expect(m.committedValue(a, 'A')).toBe(5);
		selfCheck(m);
	});
});

describe('case 4 — two-batch write into an already-stale region (re-notify)', () => {
	it('dedup is per-(watcher, slot): the second batch delivers in ITS lane', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const t1 = m.openBatch('deferred');
		const t2 = m.openBatch('deferred');
		m.write(t1.id, a, set(1));
		m.write(t2.id, a, set(2)); // before any re-render
		const deliveries = m.eventsOfType('delivery').filter((e) => e.watcher === 'W');
		expect(deliveries).toHaveLength(2);
		expect(deliveries[0]!.batch).toBe(t1.id);
		expect(deliveries[1]!.batch).toBe(t2.id); // in T2's lane — marks gate routing, never delivery
		expect(w.dedup.size).toBe(2);
		m.retire(t1.id);
		m.retire(t2.id);
		selfCheck(m);
	});
});

describe('case 5 — cutoff-suppressed first write, effective second write (same batch)', () => {
	it('delivery is value-blind; a re-rendered watcher re-arms; folds always see the newest slot state', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const b = m.atom('b', 0);
		const c = m.computed('c', (read) => (read(a) as number) * 0 + (read(b) as number));
		const w = mountCommitted(m, 'A', c, 'W');
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(1)); // c's value unaffected — delivered anyway (≤1 spurious render, priced)
		expect(m.eventsOfType('delivery').filter((e) => e.watcher === 'W')).toHaveLength(1);
		const pk = openRender(m, 'A', [k]);
		m.renderWatcher(pk.id, w.id); // W re-renders in k's lane: dedup re-arms
		expect(w.dedup.size).toBe(0);
		m.renderEnd(pk.id, 'commit');
		m.write(k.id, b, set(7)); // fresh setState in k's lane
		expect(m.eventsOfType('delivery').filter((e) => e.watcher === 'W')).toHaveLength(2);
		const pk2 = openRender(m, 'A', [k]);
		expect(m.renderValue(c, pk2)).toBe(7); // the 7-based value — validity is clock-based, never first-eval
		m.renderEnd(pk2.id, 'commit', { retireAtCommit: [k.id] });
		expect(w.lastRenderedValue).toBe(7);
		selfCheck(m);
	});
});

describe('case 6 — lane attribution under grouped notification', () => {
	it('no implicit grouping: each write delivers NOW in its own context', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const b = m.atom('b', 0);
		const ca = m.computed('ca', (read) => read(a));
		const cb = m.computed('cb', (read) => read(b));
		mountCommitted(m, 'A', ca, 'Wa');
		mountCommitted(m, 'A', cb, 'Wb');
		const urgent = m.openBatch('urgent'); // the ambient event batch
		const transition = m.openBatch('deferred'); // startTransition inside the same engine batch()
		m.write(urgent.id, a, set(1)); // delivery NOW, urgent context
		m.write(transition.id, b, set(2)); // delivery NOW, transition context
		const dA = m.eventsOfType('delivery').find((e) => e.watcher === 'Wa')!;
		const dB = m.eventsOfType('delivery').find((e) => e.watcher === 'Wb')!;
		expect(dA.batch).toBe(urgent.id); // watcher setStates inherit the writer's lanes
		expect(dB.batch).toBe(transition.id);
		m.retire(urgent.id);
		m.retire(transition.id);
		selfCheck(m);
	});
});

describe('case 7 — writes and reads during a yielded render pass', () => {
	it('yield-gap handlers read NEWEST and write into their own batch; the pinned world never drifts', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(5));
		const p = openRender(m, 'A', [t]);
		m.renderYield(p.id); // after renderYield this callstack is outside the render — truth is per-callstack
		expect(m.newestValue(a)).toBe(5); // handler read: the newest world (includes T's applied write)
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(9)); // no throw; classifies into the click's batch U
		m.retire(u.id); // even if U retires mid-yield: retiredSeq > pin ⇒ excluded
		m.renderResume(p.id);
		expect(m.renderValue(a, p)).toBe(5); // pinned world stable
		m.renderEnd(p.id, 'commit', { retireAtCommit: [t.id] });
		expect(m.committedValue(a, 'A')).toBe(9); // replay by sequence: set 5 then set 9
		selfCheck(m);
	});

	it('included-batch mid-render retirement: release blocked; clause 2 load-bearing; freed at render end', () => {
		const m = concurrent();
		const b = m.atom('b', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, b, set(7)); // @95, before P pins
		const p = openRender(m, 'A', [t]);
		m.renderYield(p.id);
		m.write(t.id, b, set(9)); // post-pin T-attributed write: stays excluded
		m.retire(t.id); // T's remaining React work lived on other roots
		const slot = m.idToBatch.get(t.id)!.slot;
		expect(slot).toBeDefined(); // release BLOCKED: P's mask names it
		expect(m.slots[slot!]!.releasePending).toBe(true);
		expect(m.renderValue(b, p)).toBe(7); // clause 1 fails (rs > pin); clause 2: mask ∋ T ∧ 95 ≤ pin
		m.renderResume(p.id);
		m.renderEnd(p.id, 'discard'); // commit and discard alike re-evaluate the deferred release
		expect(m.eventsOfType('slot-released').some((e) => e.batch === t.id)).toBe(true);
		expect(m.committedValue(b, 'A')).toBe(9);
		selfCheck(m);
	});
});

describe('case 8 — equality drops must not lose log entries', () => {
	it('equal-to-newest writes append; abandonment folds; only the empty-log equal drop is legal', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1)); // write log empty, 1 ≠ 0 ⇒ append
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(1)); // equal to the NEWEST value: write log non-empty ⇒ ALWAYS append
		expect(a.log).toHaveLength(2);
		const pu = openRender(m, 'A', [u]);
		expect(m.renderValue(a, pu)).toBe(1); // U's render (excluding T): base 0 + U's set → 1
		m.renderEnd(pu.id, 'commit', { retireAtCommit: [u.id] });
		m.retire(t.id); // T abandoned: retirement is disposition-blind — identical fold path
		expect(m.committedValue(a, 'A')).toBe(1); // U's log entry independently commits 1
		// the legal drop: quiescent log-free equal write
		const q = m.atom('q', 3);
		const d = m.openBatch('default');
		m.write(d.id, q, set(3));
		expect(m.eventsOfType('write-dropped').filter((e) => e.node === 'q')).toHaveLength(1);
		expect(q.log).toHaveLength(0);
		m.retire(d.id);
		selfCheck(m);
	});

	it('two overlapping transitions writing 1: both append; every world folds to 1', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t1 = m.openBatch('deferred');
		const t2 = m.openBatch('deferred');
		m.write(t1.id, a, set(1));
		m.write(t2.id, a, set(1));
		expect(a.log).toHaveLength(2);
		const p1 = openRender(m, 'A', [t1]);
		expect(m.renderValue(a, p1)).toBe(1);
		m.renderEnd(p1.id, 'commit', { retireAtCommit: [t1.id] });
		const p2 = openRender(m, 'A', [t2]);
		expect(m.renderValue(a, p2)).toBe(1);
		m.renderEnd(p2.id, 'commit', { retireAtCommit: [t2.id] });
		expect(m.committedValue(a, 'A')).toBe(1);
		selfCheck(m);
	});
});

describe('case 9 — mount mid-transition (existing and fresh nodes)', () => {
	it('(a) mount inside k\'s own render: first render in the k-world, zero corrections', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => (read(a) as number) + 1);
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(4));
		const pk = openRender(m, 'A', [k]);
		const w = m.mountWatcher(pk.id, c, 'W');
		expect(w.lastRenderedValue).toBe(5); // the k-world value on the FIRST render — no canonical leak
		m.renderEnd(pk.id, 'commit');
		expect(m.eventsOfType('mount-corrective')).toHaveLength(0); // inclusion+clock skip — never value equality
		expect(m.eventsOfType('mount-urgent-correction')).toHaveLength(0); // fast-out: zero evaluations
		m.retire(k.id);
		selfCheck(m);
	});

	it('(c) foreign retirement in the render→commit window fires the pre-paint correction', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => (read(a) as number) + 1);
		const k = m.openBatch('deferred'); // the transition being rendered
		const pk = openRender(m, 'A', [k]);
		const w = m.mountWatcher(pk.id, c, 'W');
		expect(w.lastRenderedValue).toBe(1);
		m.renderYield(pk.id);
		const d = m.openBatch('default'); // store-only D writes a and RETIRES during the yield
		m.write(d.id, a, set(3));
		m.retire(d.id);
		m.renderResume(pk.id);
		m.renderEnd(pk.id, 'commit');
		// fast-out fails (baseline.committedAdvance > pin) ⇒ v_fx (retired-at-now ∋ D) ≠ v_r ⇒ urgent pre-paint setState
		const fix = m.eventsOfType('mount-urgent-correction').filter((e) => e.watcher === 'W');
		expect(fix).toHaveLength(1);
		expect(fix[0]!.to).toBe(4);
		expect(w.lastRenderedValue).toBe(4);
		m.retire(k.id);
		selfCheck(m);
	});

	it('(d) own-commit fold of a post-pin included write falls through and fires', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(1));
		const pk = openRender(m, 'A', [k]);
		const w = m.mountWatcher(pk.id, a, 'W');
		expect(w.lastRenderedValue).toBe(1);
		m.renderYield(pk.id);
		m.write(k.id, a, set(2)); // k-attributed write @s2 > pin lands mid-yield (e.g. a runInBatch-delivered member write)
		m.renderResume(pk.id);
		m.renderEnd(pk.id, 'commit', { retireAtCommit: [k.id] }); // k retires AT P_k's commit
		const fix = m.eventsOfType('mount-urgent-correction').filter((e) => e.watcher === 'W');
		expect(fix).toHaveLength(1); // wc[k] > pin ⇒ fast-out falls through; v_fx folds s2
		expect(w.lastRenderedValue).toBe(2);
		selfCheck(m);
	});

	it('(d\') if k stays live instead, the corrective loop covers it and no false urgent fires', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(1));
		const pk = openRender(m, 'A', [k]);
		const w = m.mountWatcher(pk.id, a, 'W');
		m.renderYield(pk.id);
		m.write(k.id, a, set(2));
		m.renderResume(pk.id);
		m.renderEnd(pk.id, 'commit'); // k live: lock-in, no retirement
		expect(m.eventsOfType('mount-corrective').filter((e) => e.watcher === 'W' && e.batch === k.id)).toHaveLength(1);
		// A deliberate, documented subtlety (the "flag 5" family — see
		// concurrent-flags.spec.ts): one might expect the mount compare to come out
		// equal here — no false urgent — when k stays live. But the commit updates
		// the root's committed-batch table before layout effects run, and a root's
		// committed world closes over EVERY write of a batch it has committed, so
		// committed-for-A already includes k's post-pin write and the fixup's
		// committed clause folds s2: the compare fires — a value-TRUE urgent
		// correction. Over-firing here cannot be unsound: the correction writes
		// exactly the committed truth.
		expect(m.eventsOfType('mount-urgent-correction')).toHaveLength(1);
		expect(w.lastRenderedValue).toBe(2);
		expect(m.committedValue(a, 'A')).toBe(2); // the correction matches committed truth — not false
		m.retire(k.id);
		selfCheck(m);
	});

	it('(e) reveal-shaped mount: render-pass-id conjunct fails, conservative compare corrects pre-paint', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => (read(a) as number) + 1);
		const hidden = openRender(m, 'A', []); // Activity pre-renders W hidden (pin p1, mask ∅)
		const w = m.mountWatcher(hidden.id, c, 'W');
		expect(w.lastRenderedValue).toBe(1);
		m.deferMountEffects(w.id); // effects deferred: the hidden commit runs no fixup for W
		m.renderEnd(hidden.id, 'commit');
		expect(w.live).toBe(false);
		const u = m.openBatch('urgent'); // one event writes a@s2 > p1 and reveals
		m.write(u.id, a, set(6));
		const pu = openRender(m, 'A', [u]);
		m.adoptRevealedMount(pu.id, w.id); // W's layout effects fire inside u's commit
		m.renderEnd(pu.id, 'commit', { retireAtCommit: [u.id] });
		// render-pass-id conjunct FAILS ⇒ conservative fall-through ⇒ w_fx compare corrects pre-paint
		const fix = m.eventsOfType('mount-urgent-correction').filter((e) => e.watcher === 'W');
		expect(fix).toHaveLength(1);
		expect(w.lastRenderedValue).toBe(7);
		expect(w.live).toBe(true);
		selfCheck(m);
	});
});

describe('case 10 — late subscription joins the pending batch (entanglement)', () => {
	it('normal path: the corrective joins k\'s OWN lanes; exactly one commit', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(5)); // W not yet mounted: no watcher record, no delivery
		expect(m.eventsOfType('delivery')).toHaveLength(0);
		const urgent = openRender(m, 'A', []); // urgent render mounts W; w_r excludes k
		const w = m.mountWatcher(urgent.id, c, 'W');
		expect(w.lastRenderedValue).toBe(0); // committed value rendered
		m.renderEnd(urgent.id, 'commit');
		// layout: subscribe, then fixup: k live, slot(k) ∉ includedSet ⇒ runInBatch(k, setStateW)
		expect(m.eventsOfType('mount-corrective').filter((e) => e.watcher === 'W' && e.batch === k.id)).toHaveLength(1);
		expect(m.eventsOfType('mount-urgent-correction')).toHaveLength(0); // no urgent tear
		const pk = openRender(m, 'A', [k]); // k's render includes W
		m.renderWatcher(pk.id, w.id);
		expect(m.renderValue(c, pk)).toBe(5);
		m.renderEnd(pk.id, 'commit', { retireAtCommit: [k.id] }); // ONE commit carrying k and W's correction
		expect(w.lastRenderedValue).toBe(5);
		selfCheck(m);
	});

	it('race (i): k retires in the render→layout window — the w_fx compare corrects pre-paint', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(5));
		const urgent = openRender(m, 'A', []);
		const w = m.mountWatcher(urgent.id, c, 'W');
		m.renderYield(urgent.id);
		m.retire(k.id); // k retires in the window
		m.renderResume(urgent.id);
		m.renderEnd(urgent.id, 'commit');
		// loop sees no live k; fast-out fails (committedAdvance moved past the baseline) ⇒ v_fx ∋ k (retired) ≠ v_r
		expect(m.eventsOfType('mount-corrective')).toHaveLength(0);
		expect(m.eventsOfType('mount-urgent-correction').filter((e) => e.watcher === 'W')).toHaveLength(1);
		expect(w.lastRenderedValue).toBe(5);
		selfCheck(m);
	});
});

describe('case 11 — multiple roots (declared scope: degraded multi-root)', () => {
	it('per-root self-consistency; visible skew; exactly-once retirement; rows clear before release', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const wA = mountCommitted(m, 'A', c, 'WA');
		const wB = mountCommitted(m, 'B', c, 'WB');
		const k = m.openBatch('deferred'); // spans roots A and B
		m.write(k.id, a, set(1));
		const eA = m.mountReactEffect('A', c, 'EA');
		// A commits k first (lock-in): k does NOT retire (B pending)
		const pA = openRender(m, 'A', [k]);
		m.renderWatcher(pA.id, wA.id);
		m.renderEnd(pA.id, 'commit');
		expect(m.eventsOfType('per-root-commit').filter((e) => e.root === 'A' && e.batch === k.id)).toHaveLength(1);
		expect(m.idToBatch.get(k.id)!.state).toBe('live');
		// later urgent render on A: its world includes A's captured committed set ∋ k
		const uA = openRender(m, 'A', []);
		expect(m.renderValue(c, uA)).toBe(1); // A never contradicts its own DOM
		m.renderEnd(uA.id, 'commit');
		expect(eA.lastValue).toBe(1); // A's passive effects observe k before k fully retires
		// B still pending: committed-for-B excludes k — the declared, documented skew
		expect(m.committedValue(c, 'B')).toBe(0);
		const uB = openRender(m, 'B', []);
		expect(m.renderValue(c, uB)).toBe(0); // but B is self-consistent
		m.renderEnd(uB.id, 'commit');
		// B commits k: now committed everywhere ⇒ the host React build retires it EXACTLY ONCE
		const pB = openRender(m, 'B', [k]);
		m.renderWatcher(pB.id, wB.id);
		m.renderEnd(pB.id, 'commit', { retireAtCommit: [k.id] });
		expect(m.eventsOfType('retired').filter((e) => e.batch === k.id)).toHaveLength(1);
		expect(m.roots.get('A')!.committedBatches.has(k.id)).toBe(false); // rows cleared at retirement
		expect(m.eventsOfType('slot-released').some((e) => e.batch === k.id)).toBe(true);
		expect(wA.lastRenderedValue).toBe(1);
		expect(wB.lastRenderedValue).toBe(1);
		selfCheck(m);
	});
});

describe('case 12 — store-only transitions persist; async is React parity', () => {
	it('store-only abandoned batches fold: persistence never depends on subscription', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(5)); // no subscribers, no React work
		m.retire(t.id); // abandoned ⇒ the SAME retirement path: fold
		expect(m.committedValue(a, 'A')).toBe(5);
		expect(m.newestValue(a)).toBe(5);
		selfCheck(m);
	});

	it('raw post-await writes are ambient and commit before settlement; write order wins at settlement', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred', { action: true }); // action T
		m.write(t.id, a, set(1)); // synchronous prefix: classifies into T; T parks
		expect(() => m.retire(t.id)).toThrow(); // parked batches retire only at settlement
		m.bareWrite(a, set(2)); // continuation runs bare ⇒ ambient default D (the post-await lint is adapter-only)
		const d = m.idToBatch.get(m.ambientBatch!)!;
		m.retire(d.id); // D retires on its own schedule
		expect(m.committedValue(a, 'A')).toBe(2); // BEFORE the action settles — React parity
		m.settleAction(t.id); // T settles ⇒ retires; replay base→set(1)→set(2) by seq
		expect(m.committedValue(a, 'A')).toBe(2); // committed stays 2 (write order wins)
		expect(a.log).toHaveLength(0); // full prefix retired ⇒ compaction
		expect(a.base).toBe(2);
		selfCheck(m);
	});

	it('member-write variant: both writes carry T; fold lands only at settlement', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred', { action: true });
		m.write(t.id, a, set(1));
		m.write(t.id, a, set(2)); // post-await member write, attributed to the action's still-live batch
		expect(m.committedValue(a, 'A')).toBe(0); // not before settlement
		m.settleAction(t.id);
		expect(m.committedValue(a, 'A')).toBe(2);
		expect(() => m.write(t.id, a, set(3))).toThrow(/retired batch/); // a settled action's batch fails loudly — never silently urgent
		selfCheck(m);
	});
});

describe('case 13 — counter/world-id lifecycle soundness (model rows)', () => {
	it('quiescence → episode reset: folds preserved; epoch bumps; counters stay monotone (never renumbered)', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, update((x) => (x as number) + 41));
		m.write(t.id, a, update((x) => (x as number) + 1));
		commitAndRetire(m, 'A', t);
		const lastBatchId = t.id;
		expect(m.committedValue(a, 'A')).toBe(42);
		const seqBefore = m.seq;
		m.quiesce();
		expect(m.epoch).toBe(1);
		expect(m.seq).toBeGreaterThanOrEqual(seqBefore); // counters are NEVER rewritten (exact to 2^53; renumbering deleted)
		expect(m.committedValue(a, 'A')).toBe(42); // folds unchanged across the episode reset
		expect(m.newestValue(a)).toBe(42);
		// new episode: everything still works, batch serials keep climbing
		const t2 = m.openBatch('urgent');
		expect(t2.id).toBeGreaterThan(lastBatchId);
		m.write(t2.id, a, set(1));
		commitAndRetire(m, 'A', t2);
		expect(m.committedValue(a, 'A')).toBe(1);
		m.quiesce();
		expect(m.epoch).toBe(2);
		selfCheck(m);
	});

	it('mid-episode slot recycle: write clock and dedup bits reset at claim', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(1));
		const slot = m.idToBatch.get(k.id)!.slot!;
		expect(w.dedup.has(slot)).toBe(true); // armed by k's delivery
		m.retire(k.id);
		const v = m.openBatch('deferred');
		m.write(v.id, a, set(2)); // claims the same slot
		expect(m.idToBatch.get(v.id)!.slot).toBe(slot);
		// dedup bits cleared at claim: V's first delivery is FRESH, not suppressed by k's stale bit
		const vDeliveries = m.eventsOfType('delivery').filter((e) => e.batch === v.id && e.watcher === 'W');
		expect(vDeliveries).toHaveLength(1);
		expect(vDeliveries[0]!.mode).toBe('fresh');
		m.retire(v.id);
		selfCheck(m);
	});
});

describe('case 14 — StrictMode and replayed renders (model-expressible half)', () => {
	it('double-invoked world reads are idempotent: no graph mutation, same values', () => {
		const m = concurrent();
		const a = m.atom('a', 1);
		const c = m.computed('c', (read) => (read(a) as number) * 3);
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(2));
		const pk = openRender(m, 'A', [k]);
		const events = m.events.length;
		const v1 = m.renderValue(c, pk);
		const v2 = m.renderValue(c, pk); // the replayed twin
		expect(v1).toBe(6);
		expect(v2).toBe(6);
		expect(m.events.length).toBe(events); // evaluation emits nothing and mutates nothing observable
		m.renderEnd(pk.id, 'discard');
		m.retire(k.id);
		selfCheck(m);
	});

	it('render-phase writes throw in all builds', () => {
		// Engine leg (see the header note): same schedule, driven on the bridge.
		const m = __newBridgeForTest();
		m.registerBridge();
		const a = m.atom('a', 0);
		const t = m.openBatch();
		let misbehave = true;
		const evil = m.computed('evil', () => {
			if (misbehave) m.write(t.id, a, 0, 1); // a write during render
			return 0;
		});
		expect(() => m.newestValue(evil)).toThrow(/write during a world evaluation/);
		expect(a.log.materialize()).toHaveLength(0); // nothing landed
		misbehave = false; // the node behaves from here so later evaluations are clean
		m.retire(t.id);
		expect(m.newestValue(a)).toBe(0);
	});
});

describe('case 15 — Suspense across worlds', () => {
	it.skip('requires the React fork (lineage capsules, thenables, retries) — see tests/SKIPPED-FOR-FORK-SUITE.md', () => {});
});

describe('case 16 — effects observe committed state only', () => {
	it('useSignalEffect excludes applied-but-uncommitted writes; re-runs at commit and at flips', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const e = m.mountReactEffect('A', a, 'E');
		const ce = m.mountCoreEffect(a, 'CE');
		const d = m.openBatch('default');
		m.write(d.id, a, set(1)); // applied, not committed
		expect(ce.lastValue).toBe(1); // core contract: NEWEST, at the write's flush
		const x = m.openBatch('urgent'); // an unrelated retirement flushes effects
		const other = m.atom('other', 0);
		m.write(x.id, other, set(1));
		m.retire(x.id);
		expect(e.lastValue).toBe(0); // committed-for-root: D excluded
		expect(e.runs).toBe(0);
		commitAndRetire(m, 'A', d); // D commits
		expect(e.lastValue).toBe(1); // re-runs, sees 1
		expect(e.runs).toBe(1);
		selfCheck(m);
	});

	it('an older entry becoming visible beneath a visible max re-runs the effect (retirement flip)', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const e = m.mountReactEffect('A', a, 'E');
		const t1 = m.openBatch('deferred');
		m.write(t1.id, a, update((x) => (x as number) + 1)); // s1: +1
		const t2 = m.openBatch('urgent');
		m.write(t2.id, a, update((x) => (x as number) * 2)); // s2: ×2
		m.retire(t2.id); // committed fold: only ×2 visible → 0
		expect(e.lastValue).toBe(0);
		m.retire(t1.id); // s1 retires BENEATH the already-visible s2: (0+1)×2 = 2
		expect(e.lastValue).toBe(2); // the flip re-ran the effect
		expect(e.runs).toBe(1);
		selfCheck(m);
	});

	it('a per-root commit flips the root committed view and revalidates effects at the drain', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const e = m.mountReactEffect('A', a, 'E');
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(7));
		expect(e.lastValue).toBe(0);
		const pA = openRender(m, 'A', [k]);
		m.renderEnd(pA.id, 'commit'); // lock-in (k stays live: pretend it spans roots)
		expect(e.lastValue).toBe(7); // the advance drained A's committed observers
		expect(e.runs).toBe(1);
		m.retire(k.id);
		expect(e.runs).toBe(1); // full retirement changes nothing further for A (value equal)
		selfCheck(m);
	});

	// The EF2 boundary re-pin (amended 2026-07-06): the three killing
	// schedules from the unification plan reviews, pinned mutation-style —
	// the OLD immediate member-write revalidation and the naive
	// next-drain-only deferral each fail at least one of these.

	it('16b — a committed-member write NEVER re-fires under an open same-root frame; the flip flushes at the frame close (kills immediate revalidation — codex finding 2)', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred', { action: true }); // parked action: its batch stays live for member writes
		m.write(t.id, a, set(1));
		const p0 = openRender(m, 'A', [t]);
		m.renderEnd(p0.id, 'commit'); // t locks into A (still live, parked)
		const e = m.mountReactEffect('A', a, 'E'); // snapshot: a@1
		expect(e.lastValue).toBe(1);
		const p1 = openRender(m, 'A', []); // A opens a new frame pinned at a=1…
		m.renderYield(p1.id);
		m.write(t.id, a, set(2)); // …and committed truth for A moves NOW (membership clause)
		expect(e.runs).toBe(0); // the effect must NOT run ahead of A's own open frame (EF1/CR4)
		const x = m.openBatch('urgent');
		m.write(x.id, m.atom('other', 0), set(1));
		m.retire(x.id); // a boundary — but A's frame is still open: deferred
		expect(e.runs).toBe(0);
		m.renderResume(p1.id);
		m.renderEnd(p1.id, 'discard'); // the frame close is the deferred flush point
		expect(e.runs).toBe(1);
		expect(e.lastValue).toBe(2);
		m.settleAction(t.id);
		expect(e.runs).toBe(1); // value unchanged at settlement: the gate holds
		selfCheck(m);
	});

	it('16c — member writes COALESCE: N writes before one boundary produce ONE cleanup+run at the boundary value', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred', { action: true });
		m.write(t.id, a, set(1));
		const p = openRender(m, 'A', [t]);
		m.renderEnd(p.id, 'commit'); // t committed into A
		const e = m.mountReactEffect('A', a, 'E'); // snapshot a@1
		m.write(t.id, a, set(2));
		m.write(t.id, a, set(3));
		m.write(t.id, a, set(4)); // three member writes, no boundary between
		expect(e.runs).toBe(0); // never mid-write (the old adapter fired here, three times)
		m.settleAction(t.id); // ONE boundary
		expect(e.runs).toBe(1); // ONE cleanup+run…
		expect(e.cleanups).toBe(1);
		expect(e.lastValue).toBe(4); // …at the boundary value (2 and 3 were never observed)
		selfCheck(m);
	});

	it('16d — unmount before the boundary runs cleanup and nothing after teardown (a make-up fire is not owed — fable M3 re-walked under the ruling)', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred', { action: true });
		m.write(t.id, a, set(1));
		const p = openRender(m, 'A', [t]);
		m.renderEnd(p.id, 'commit');
		const e = m.mountReactEffect('A', a, 'E'); // snapshot a@1
		m.write(t.id, a, set(2)); // a durable flip while the effect is live…
		m.removeReactEffect(e.id); // …but the effect unmounts before any boundary
		expect(e.cleanups).toBe(1); // cleanup is GUARANTEED at unmount
		const runsBefore = m.eventsOfType('react-effect-run').length;
		m.settleAction(t.id); // the boundary arrives after teardown
		expect(m.eventsOfType('react-effect-run')).toHaveLength(runsBefore); // no fire after teardown (RCC-OL2)
		expect(e.runs).toBe(0);
		selfCheck(m);
	});

	it('16e — a dep-choosing body re-tracks CAUSALLY: writes to the un-chosen arm stop firing after the flip', () => {
		const m = concurrent();
		const flag = m.atom('flag', 0);
		const a = m.atom('a', 10);
		const b = m.atom('b', 20);
		const e = m.mountReactEffectPick('A', flag, a, b, 'E'); // flag=0 → reads b
		expect(e.deps.map((d) => d.node.name)).toEqual(['flag', 'b']);
		const t1 = m.openBatch('urgent');
		m.write(t1.id, b, set(21));
		m.retire(t1.id); // b is in the snapshot → re-fire + recapture
		expect(e.runs).toBe(1);
		expect(e.lastValue).toBe(21);
		const t2 = m.openBatch('urgent');
		m.write(t2.id, a, set(11));
		m.retire(t2.id); // a is NOT in the snapshot: no fire
		expect(e.runs).toBe(1);
		const t3 = m.openBatch('urgent');
		m.write(t3.id, flag, set(1));
		m.retire(t3.id); // the flip fires; the body re-chooses its deps
		expect(e.runs).toBe(2);
		expect(e.lastValue).toBe(11);
		expect(e.deps.map((d) => d.node.name)).toEqual(['flag', 'a']);
		const t4 = m.openBatch('urgent');
		m.write(t4.id, b, set(99));
		m.retire(t4.id); // b is no longer read: no fire
		expect(e.runs).toBe(2);
		const t5 = m.openBatch('urgent');
		m.write(t5.id, a, set(12));
		m.retire(t5.id); // the re-chosen arm fires
		expect(e.runs).toBe(3);
		selfCheck(m);
	});

	it('16f — a WRITE-FREE retirement still flushes a pending member-write flip (retirement/settlement are guaranteed flush points; kills bits-gated deferral)', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred', { action: true });
		m.write(t.id, a, set(1));
		const p = openRender(m, 'A', [t]);
		m.renderEnd(p.id, 'commit');
		const e = m.mountReactEffect('A', a, 'E');
		m.write(t.id, a, set(2)); // pending flip, no boundary yet
		const y = m.openBatch('urgent'); // never writes
		m.retire(y.id); // write-free retirement: STILL a boundary
		expect(e.runs).toBe(1);
		expect(e.lastValue).toBe(2);
		const z = m.openBatch('urgent');
		m.retire(z.id); // and value-gated: a second one fires nothing
		expect(e.runs).toBe(1);
		m.settleAction(t.id);
		expect(e.runs).toBe(1);
		selfCheck(m);
	});

	it('16g — StrictMode-style replay: cleanup + unconditional re-run + recapture; boundaries stay value-gated after', () => {
		const m = concurrent();
		const a = m.atom('a', 5);
		const e = m.mountReactEffect('A', a, 'E');
		m.replayReactEffect(e.id); // cleanup + re-run at the same values
		expect(e.cleanups).toBe(1);
		expect(e.runs).toBe(1);
		expect(e.lastValue).toBe(5);
		const x = m.openBatch('urgent');
		m.write(x.id, m.atom('other', 0), set(1));
		m.retire(x.id); // unrelated boundary: the value gate holds
		expect(e.runs).toBe(1);
		selfCheck(m);
	});

	it('16h — one render locking in TWO batches re-checks once, at the boundary value (one re-check per boundary, not per batch)', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const e = m.mountReactEffect('A', a, 'E');
		const t1 = m.openBatch('deferred');
		m.write(t1.id, a, update((x) => (x as number) + 1)); // +1
		const t2 = m.openBatch('deferred');
		m.write(t2.id, a, update((x) => (x as number) * 10)); // ×10
		const p = openRender(m, 'A', [t1, t2]);
		m.renderEnd(p.id, 'commit'); // BOTH lock in at one commit
		expect(e.runs).toBe(1); // one re-check per boundary…
		expect(e.lastValue).toBe(10); // …at the boundary value (0+1)×10 — the intermediate 1 is never observed
		m.retire(t1.id);
		m.retire(t2.id);
		expect(e.runs).toBe(1); // retirements move nothing further
		selfCheck(m);
	});
});

describe('case 17 — optimistic rollback: the feature is deleted', () => {
	it('no truncation, rollback, or revert affordance exists on the public model surface', () => {
		const m = concurrent();
		const surface = [
			...Object.getOwnPropertyNames(Object.getPrototypeOf(m)),
			...Object.keys(m),
		].map((s) => s.toLowerCase());
		for (const forbidden of ['truncate', 'rollback', 'revert', 'undo']) {
			expect(surface.filter((s) => s.includes(forbidden))).toHaveLength(0);
		}
		// log entries cannot be un-appended: the op vocabulary is set/update only
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1));
		m.retire(t.id); // abandoned still folds (the only "cancellation" is... nothing)
		expect(m.committedValue(a, 'A')).toBe(1);
		selfCheck(m);
	});
});
