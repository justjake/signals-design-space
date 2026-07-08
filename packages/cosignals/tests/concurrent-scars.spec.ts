// TWIN RUN — this spec runs against the reference model (`cosignals-oracle`)
// and the concurrent engine at once: ./helpers.js here is the lockstep driver (model
// + engine fan-out; every read is parity-asserted; selfCheck compares
// events/snapshots and runs the invariant battery on BOTH sides). Kept in
// lockstep with the reference model's own tests/scars.spec.ts.
/**
 * Pinned regression schedules ("scars"): each test replays the schedule
 * under which some rejected design for this engine produced a wrong
 * outcome — every one expressible at model level — and asserts the CORRECT
 * outcome that design got wrong, so the failure can never return silently.
 * The S-numbers are stable identifiers shared with the reference model's
 * suite. Scars needing the real patched React build are listed in
 * SKIPPED-FOR-FORK-SUITE.md alongside that suite, one line each.
 */
import { describe, expect, it } from 'vitest';
import { Atom } from '../src/index.js';
import { commitAndRetire, concurrent, mountCommitted, openRender, selfCheck, set, TwinDriver, update } from './helpers.js';

describe('pinned scars (model-expressible)', () => {
	it('S1 — no-log urgent writes: urgent ×2 over pending +1 commits 2 then 4, never 3', () => {
		const m = concurrent();
		const a = m.atom('a', 1);
		const t = m.openBatch('deferred');
		m.write(t.id, a, update((x) => (x as number) + 1));
		const u = m.openBatch('urgent');
		m.write(u.id, a, update((x) => (x as number) * 2)); // logged although urgent
		commitAndRetire(m, 'A', u);
		expect(m.committedValue(a, 'A')).toBe(2); // not 4, not 3: replay over the pre-batch base
		commitAndRetire(m, 'A', t);
		expect(m.committedValue(a, 'A')).toBe(4); // React commits 4; drop-the-log designs fold 3
		selfCheck(m);
	});

	it('S2/S3 — kernel-topology-only marking/notify misses the divergent dep: the real k-edge delivers', () => {
		const m = concurrent();
		const flag = m.atom('flag', 0);
		const a = m.atom('a', 0);
		const b = m.atom('b', 0);
		const c = m.computed('c', (read) => (read(flag) ? read(a) : read(b)));
		mountCommitted(m, 'A', c, 'W');
		const k = m.openBatch('deferred');
		m.write(k.id, flag, set(1));
		const pk = openRender(m, 'A', [k]);
		expect(m.renderValue(c, pk)).toBe(0); // the k-world evaluation records the REAL dep a→c
		m.write(k.id, a, set(1)); // committed topology has no a→c edge — the trap
		// the watcher IS notified in k's lane (interleaved: render open, pin < seq)
		const kDeliveries = m.eventsOfType('delivery').filter((e) => e.watcher === 'W' && e.batch === k.id);
		expect(kDeliveries.length).toBeGreaterThanOrEqual(2);
		m.renderEnd(pk.id, 'discard');
		const pk2 = openRender(m, 'A', [k]);
		expect(m.renderValue(c, pk2)).toBe(1); // no stale forever-cache
		expect(m.committedValue(c, 'A')).toBe(0);
		m.renderEnd(pk2.id, 'commit', { retireAtCommit: [k.id] });
		selfCheck(m);
	});

	it('S4 — drop-on-abort retirement: abandoned batches fold; writes never silently revert', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(5)); // no subscriber → no React work → React will abandon the batch
		m.retire(t.id);
		expect(m.committedValue(a, 'A')).toBe(5); // persistence must never depend on subscription
		selfCheck(m);
	});

	it('S5 — eval-time-only validity: an atom acquiring its first log entry AFTER a world read still invalidates', () => {
		const m = concurrent();
		const a = m.atom('a', 0); // unlogged when world-k first reads it
		const c = m.computed('c', (read) => (read(a) as number) + 1);
		const k = m.openBatch('deferred');
		m.write(k.id, m.atom('warm', 0), set(1)); // k exists with unrelated state
		const pk = openRender(m, 'A', [k]);
		expect(m.renderValue(c, pk)).toBe(1); // first read: a has no write log
		m.renderEnd(pk.id, 'discard');
		m.write(k.id, a, set(9)); // a acquires a write log only now
		const pk2 = openRender(m, 'A', [k]);
		expect(m.renderValue(c, pk2)).toBe(10); // a fresh k render must see it (no stale certificate)
		m.renderEnd(pk2.id, 'discard');
		m.retire(k.id);
		selfCheck(m);
	});

	it('S6 — machinery keyed to watcher count: standalone history is committed-only state', () => {
		// Re-pinned at SYSTEM level (always-concurrent): the registration era
		// ceased to exist — a handle exists ⟺ the engine can resolve it, and
		// its engine CONTENT allocates on first participation. The truth this
		// scar protects: standalone history (plain kernel writes while quiet
		// with no engine content — the node-less arm) joins as committed-only
		// base state — an empty write log, no log entries, no batches, no
		// events — and machinery never keys to a watcher-count "era".
		const handle = new Atom<unknown>(0);
		handle.set(1); // REAL kernel write through the public atom API — the node-less arm
		const m = new TwinDriver(); // reset the engine; the handle's kernel record survives? NO —
		// the reset scrubs the kernel too, so the standalone history must
		// happen after the harness exists to be observable. Re-run it here:
		const handle2 = new Atom<unknown>(0);
		handle2.set(1); // node-less arm again, now inside the harness's episode
		const a = m.joinAtom('a', handle2); // joins with its kernel-current value
		expect(a.base).toBe(1); // standalone history is committed-only base state
		expect(a.log).toHaveLength(0); // ...with no log entries
		expect(m.events).toHaveLength(0); // ...no engine events
		expect(m.idToBatch.size).toBe(0); // ...and no batches
		const eInternals = m.engine.internalsForAtom(handle2); // engine face of the same emptiness
		expect(eInternals.base).toBe(1);
		expect(eInternals.log.materialize()).toHaveLength(0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		expect(w.lastRenderedValue).toBe(1); // committed-only value; urgent renders cannot leak a "transition"
		const sync = openRender(m, 'A', []);
		expect(m.renderValue(c, sync)).toBe(1);
		m.renderEnd(sync.id, 'commit');
		selfCheck(m);
	});

	it('S7 — wall-clock render scopes: a yield-gap write neither throws nor lands in the render', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1));
		const p = openRender(m, 'A', [t]);
		m.renderYield(p.id);
		const u = m.openBatch('urgent');
		expect(() => m.write(u.id, a, set(2))).not.toThrow(); // per-callstack truth: not in render
		expect(m.newestValue(a)).toBe(2); // gap reads resolve NEWEST, not the pin
		m.renderResume(p.id);
		expect(m.renderValue(a, p)).toBe(1); // and the render never sees it
		m.renderEnd(p.id, 'discard');
		m.retire(t.id);
		m.retire(u.id);
		selfCheck(m);
	});

	it('S8 — equality-gating writes against newest: U set(1) after T set(1) still appends', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1));
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(1)); // equal to newest — the scarred design dropped it
		const pu = openRender(m, 'A', [u]);
		expect(m.renderValue(a, pu)).toBe(1); // U's render excludes T and must still show 1, not 0
		m.renderEnd(pu.id, 'commit', { retireAtCommit: [u.id] });
		m.retire(t.id); // even if T dies, U's log entry independently commits 1
		expect(m.committedValue(a, 'A')).toBe(1);
		selfCheck(m);
	});

	it('S9 — unflagged ⇒ serve-anything routing: a never-evaluated node cannot leak pending state', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		// quiesce-fresh model; c has never been evaluated anywhere (no edges, no marks)
		const c = m.computed('c', (read) => (read(a) as number) + 1);
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(9)); // write to an atom with no out-edges yet
		const sync = openRender(m, 'A', []); // urgent render reads the never-evaluated node
		expect(m.renderValue(c, sync)).toBe(1); // committed world, never 10 (a torn urgent frame)
		m.renderEnd(sync.id, 'commit');
		m.retire(k.id);
		selfCheck(m);
	});

	it('S10 — equality-filtered late-join correction: subset divergence needs value-blind correctives', () => {
		const m = concurrent();
		const x1 = m.atom('x1', 0);
		const x2 = m.atom('x2', 0);
		const c = m.computed('c', (read) => ((read(x1) as number) && (read(x2) as number)) as number);
		const t1 = m.openBatch('deferred');
		const t2 = m.openBatch('deferred');
		m.write(t1.id, x1, set(1)); // per-batch projection: 1&&0 = 0 == committed
		m.write(t2.id, x2, set(1)); // per-batch projection: 0&&1 = 0 == committed
		const p = openRender(m, 'A', []); // mount excludes both
		const w = m.mountWatcher(p.id, c, 'W');
		expect(w.lastRenderedValue).toBe(0);
		m.renderEnd(p.id, 'commit');
		// equality-filtered designs skipped both correctives (all projections equal committed);
		// value-blind fixup schedules BOTH runInBatch correctives
		const corr = m.eventsOfType('mount-corrective').filter((e) => e.watcher === 'W');
		expect(corr.map((e) => e.batch).sort()).toEqual([t1.id, t2.id].sort());
		// joint render {t1,t2} then shows 1 — no torn committed frame
		const pj = openRender(m, 'A', [t1, t2]);
		m.renderWatcher(pj.id, w.id);
		m.renderEnd(pj.id, 'commit', { retireAtCommit: [t1.id, t2.id] });
		expect(w.lastRenderedValue).toBe(1);
		selfCheck(m);
	});

	it('S11/S12 — mid-render retirement on another root: the resumed render folds at its pin, always', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const n = m.computed('n', (read) => (read(a) as number) + 10);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1));
		const p = openRender(m, 'B', [t]); // render on root B
		m.renderYield(p.id);
		const d = m.openBatch('default');
		m.write(d.id, a, set(7));
		m.retire(d.id); // retires mid-yield (work on another root / store-only)
		m.renderResume(p.id);
		// FIRST read of a not-yet-read node after resume: fullyRetired-at-read-time designs leak 7
		expect(m.renderValue(n, p)).toBe(11); // pin excludes the mid-yield retirement
		expect(m.renderValue(a, p)).toBe(1); // no sibling disagreement inside one tree
		m.renderEnd(p.id, 'commit', { retireAtCommit: [t.id] });
		expect(m.committedValue(a, 'A')).toBe(7); // replay by seq: set1 then set7
		selfCheck(m);
	});

	it('S14 — canonical-equal write gating cross-world invalidation: delivery and worlds still move', () => {
		const m = concurrent();
		const a = m.atom('a', 3);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const t = m.openBatch('deferred');
		m.write(t.id, a, update((x) => (x as number) + 1)); // T-world 4, newest 4
		const pt = openRender(m, 'A', [t]);
		m.renderWatcher(pt.id, w.id); // T rendered (finished-uncommitted below)
		m.renderYield(pt.id);
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(4)); // equal to CANONICAL (newest 4): the dead design saw "kernel value unchanged" and gated invalidation on it
		// delivery fires anyway — value-blind (interleaved for W: T's render is open, pin < seq)
		expect(m.eventsOfType('delivery').filter((e) => e.watcher === 'W' && e.batch === u.id)).toHaveLength(1);
		commitAndRetire(m, 'B', u);
		m.renderResume(pt.id);
		m.renderEnd(pt.id, 'discard'); // interleaved update forces the restart
		const pt2 = openRender(m, 'A', [t]);
		expect(m.renderValue(c, pt2)).toBe(4); // replay by seq: +1@s1 → 4, then retired set(4)@s2 → 4
		m.renderEnd(pt2.id, 'commit', { retireAtCommit: [t.id] });
		expect(m.committedValue(c, 'A')).toBe(4); // T's world moved with the urgent write; nothing stale committed
		selfCheck(m);
	});

	it('S16 — value-based delivery suppression: a T-segment write returning c to committed still delivers', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1)); // T renders c=1
		const pt = openRender(m, 'A', [t]);
		m.renderWatcher(pt.id, w.id);
		m.renderYield(pt.id); // finished-but-uncommitted
		const mark = m.events.length;
		m.write(t.id, a, set(0)); // returns c to 0 == committed lastRendered 0 — the dead cutoff suppressed this
		const late = m.eventsSince(mark).filter((e) => e.type === 'delivery' && e.watcher === 'W' && e.batch === t.id);
		expect(late).toHaveLength(1); // delivered (bit re-armed at W's render); the stale finished subtree never commits as-is
		m.renderResume(pt.id);
		m.renderEnd(pt.id, 'discard');
		const pt2 = openRender(m, 'A', [t]);
		m.renderWatcher(pt2.id, w.id);
		m.renderEnd(pt2.id, 'commit', { retireAtCommit: [t.id] });
		expect(w.lastRenderedValue).toBe(0);
		selfCheck(m);
	});

	it('S17 — shared per-node walk stamps: interleaved batches never prune each other\'s deliveries', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const k = m.openBatch('deferred');
		const j = m.openBatch('deferred');
		m.write(k.id, a, set(1)); // k delivers through c
		const pk = openRender(m, 'A', [k]);
		m.renderWatcher(pk.id, w.id); // W re-arms k
		m.renderEnd(pk.id, 'commit');
		m.write(j.id, a, set(2)); // j's walk "overwrites the shared stamp" in the dead design
		m.write(k.id, a, set(3)); // k's next write must still deliver
		const kD = m.eventsOfType('delivery').filter((e) => e.watcher === 'W' && e.batch === k.id);
		expect(kD.length).toBeGreaterThanOrEqual(2); // initial + post-re-arm delivery
		m.retire(k.id);
		m.retire(j.id);
		selfCheck(m);
	});

	it('S18 — pinless shared world memos: two live pins always get their own answers', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => (read(a) as number) * 10);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1));
		const pIn = openRender(m, 'A', [t]); // includes T
		const pOut = openRender(m, 'B', []); // excludes T, different pin
		expect(m.renderValue(c, pIn)).toBe(10);
		expect(m.renderValue(c, pOut)).toBe(0); // simultaneously — no shared-slot overwrite possible
		m.write(t.id, a, set(2)); // post-pin for both
		expect(m.renderValue(c, pIn)).toBe(10); // each render keeps ITS pinned world
		expect(m.renderValue(c, pOut)).toBe(0);
		m.renderEnd(pIn.id, 'discard');
		m.renderEnd(pOut.id, 'discard');
		m.retire(t.id);
		selfCheck(m);
	});

	it('S19a — late write on a committed-but-live action: membership-visible plus a corrective, urgent-bounded', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const t = m.openBatch('deferred', { action: true });
		m.write(t.id, a, set(1));
		const pA = openRender(m, 'A', [t]);
		m.renderWatcher(pA.id, w.id);
		m.renderEnd(pA.id, 'commit'); // A commits T (lock-in); T parks on, still live
		expect(w.lastRenderedValue).toBe(1);
		const mark = m.events.length;
		m.write(t.id, a, set(2)); // post-await, post-commit member write (the action's batch is still live)
		// visible to A's committed world immediately (the committed world closes
		// over every write of a batch the root committed)…
		expect(m.committedValue(c, 'A')).toBe(2);
		// …and the corrective (the value-blind delivery in T's own lane) is scheduled
		const corr = m.eventsSince(mark).filter((e) => e.type === 'delivery' && e.watcher === 'W' && e.batch === t.id);
		expect(corr).toHaveLength(1);
		const pA2 = openRender(m, 'A', [t]); // the corrective render in the batch's own lanes
		m.renderWatcher(pA2.id, w.id);
		m.renderEnd(pA2.id, 'commit');
		expect(w.lastRenderedValue).toBe(2); // bounded window, closed
		m.settleAction(t.id);
		selfCheck(m);
	});

	it('S21/S25 — ambient classification after await: the raw write is default-batched and commits first', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred', { action: true });
		m.write(t.id, a, set(1)); // sync prefix
		m.bareWrite(a, set(2)); // timer/continuation on a bare stack (the post-await lint is adapter-only)
		const ambient = m.idToBatch.get(m.ambientBatch!)!;
		expect(ambient.ambient).toBe(true); // the auto-created ambient default batch
		m.retire(ambient.id);
		expect(m.committedValue(a, 'A')).toBe(2); // commits before the action settles — matching React's own async-action rule
		m.settleAction(t.id);
		expect(m.committedValue(a, 'A')).toBe(2); // write order wins at the fold
		selfCheck(m);
	});

	it('S23 — evaluator identity: fresh nodes per closure; a render world never sees another closure\'s output', () => {
		const m = concurrent();
		const a = m.atom('a', 1);
		const cOld = m.computed('cOld', (read) => (read(a) as number) + 100);
		const cNew = m.computed('cNew', (read) => (read(a) as number) + 200); // deps-keyed recreation
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(2));
		const pIn = openRender(m, 'A', [t]); // the render holding the NEW node via its hook state
		const pOut = openRender(m, 'B', []); // committed render holds the OLD node
		expect(m.renderValue(cNew, pIn)).toBe(202);
		expect(m.renderValue(cOld, pOut)).toBe(101); // no evaluator swap can mix these
		m.renderEnd(pIn.id, 'discard');
		m.renderEnd(pOut.id, 'discard');
		m.retire(t.id);
		selfCheck(m);
	});

	it('S26 — consumable queues: a later advance re-runs the effect even after earlier unrelated drains', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const e = m.mountReactEffect('A', a, 'E');
		const k = m.openBatch('deferred', { action: true }); // parked
		m.write(k.id, a, set(1));
		const x = m.openBatch('urgent');
		m.write(x.id, m.atom('unrelated', 0), set(1));
		m.retire(x.id); // an earlier unrelated retirement "consumes the queue entry"
		expect(e.runs).toBe(0); // k invisible to committed-for-A: correctly no run yet
		const pA = openRender(m, 'A', [k]);
		m.renderEnd(pA.id, 'commit'); // the later per-root advance exposes the parked write
		expect(e.runs).toBe(1); // durable enumeration: the advance itself drains
		expect(e.lastValue).toBe(1);
		m.settleAction(k.id);
		selfCheck(m);
	});

	it('S27 — empty-log drops with immutable evaluators: identity update drops; real update appends', () => {
		// Re-pinned for the shrunk op vocabulary: a ReducerAtom dispatch records
		// as an update whose closure captures the action, so the drop/append
		// rules are exercised through the closure form.
		const reduce = (s: unknown, act: string) => (act === 'inc' ? (s as number) + 1 : s);
		const m = concurrent();
		const r = m.atom('r', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, r, update((s) => reduce(s, 'noop'))); // evaluates equal against base → legal drop
		expect(m.eventsOfType('write-dropped')).toHaveLength(1);
		expect(r.log).toHaveLength(0);
		m.write(t.id, r, update((s) => reduce(s, 'inc'))); // 1 ≠ 0 → append
		expect(r.log).toHaveLength(1);
		m.write(t.id, r, update((s) => reduce(s, 'noop'))); // write log non-empty → ALWAYS append (equality lives at fold time)
		expect(r.log).toHaveLength(2);
		commitAndRetire(m, 'A', t);
		expect(m.committedValue(r, 'A')).toBe(1);
		selfCheck(m);
	});

	it('S29a — retirement-time mark clearing: the resumed render reads ONE world (computed and atom agree)', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const n = m.computed('n', (read) => (read(a) as number) + 11);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(100)); // T so the render has a mask
		const p = openRender(m, 'B', [t]);
		m.renderYield(p.id);
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(1));
		m.retire(u.id); // clears-at-retire designs then serve kernel n=12 beside folded a=100
		m.renderResume(p.id);
		expect(m.renderValue(a, p)).toBe(100);
		expect(m.renderValue(n, p)).toBe(111); // same world — no torn frame
		m.renderEnd(p.id, 'discard');
		m.retire(t.id);
		selfCheck(m);
	});

	it('S29b — the dual (unbounded retention) and the full-table backstop corner, loud and safe', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		// a yielded render whose mask names 5 batches that all retire mid-render
		const retained = Array.from({ length: 5 }, () => m.openBatch('deferred'));
		for (const [i, t] of retained.entries()) m.write(t.id, a, update((x) => (x as number) + 10 ** 0 * (i + 1)));
		const held = openRender(m, 'B', retained);
		m.renderYield(held.id);
		const heldBefore = m.renderValue(a, held);
		for (const t of retained) m.retire(t.id); // entangled lanes: work lived on other roots
		expect(m.slots.filter((s) => s.releasePending)).toHaveLength(5); // mask-retained
		// fresh live batches demand slots: 26 free + 5 retained = table full at the 27th claim
		const live: number[] = [];
		for (let i = 0; i < 27; i++) {
			const u = m.openBatch('urgent');
			live.push(u.id);
			m.write(u.id, a, set(i));
		}
		expect(m.eventsOfType('slot-backstop-released')).toHaveLength(1); // loud
		// safe: the retained render's log entries keep their slot fields and stay clause-2 visible below its pin
		expect(m.renderValue(a, held)).toBe(heldBefore);
		m.renderResume(held.id);
		m.renderEnd(held.id, 'discard');
		for (const id of live) m.retire(id);
		selfCheck(m);
	});

	it('S30 — transitive-chain delivery still works after episode reset (cone-carry outcome)', () => {
		const m = concurrent();
		const x = m.atom('x', 0);
		const u = m.computed('u', (read) => (read(x) as number) + 1);
		const wInternals = m.computed('w', (read) => (read(u) as number) + 1);
		const watcher = mountCommitted(m, 'A', wInternals, 'W');
		const t0 = m.openBatch('deferred');
		m.write(t0.id, x, set(1));
		commitAndRetire(m, 'A', t0, [watcher]);
		m.quiesce(); // episode reset: edges cleared, counters keep climbing
		const k = m.openBatch('deferred');
		const mark = m.events.length;
		m.write(k.id, x, set(2)); // next episode's write must reach the watcher through x→u→w
		const d = m.eventsSince(mark).filter((e) => e.type === 'delivery' && e.watcher === 'W');
		expect(d).toHaveLength(1);
		m.retire(k.id);
		selfCheck(m);
	});

	it('S33 — dedup re-armed only at render: the render-aware rule delivers the post-pin same-slot write', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const t = m.openBatch('deferred', { action: true });
		m.write(t.id, a, set(1)); // bit set, setState delivered
		expect(w.dedup.size).toBe(1);
		const pt = openRender(m, 'A', [t]); // T's render pins and yields BEFORE the watcher renders
		m.renderYield(pt.id);
		const mark = m.events.length;
		m.write(t.id, a, set(2)); // carried continuation writes post-pin
		// the dead design suppressed the only setState; the render-aware rule delivers interleaved
		const d = m.eventsSince(mark).filter((e) => e.type === 'delivery' && e.watcher === 'W' && e.batch === t.id);
		expect(d).toHaveLength(1);
		expect(d[0]!.type === 'delivery' && d[0]!.mode).toBe('interleaved');
		m.renderResume(pt.id);
		m.renderEnd(pt.id, 'discard'); // React restarts at a fresh pin for the interleaved update
		const pt2 = openRender(m, 'A', [t]);
		m.renderWatcher(pt2.id, w.id);
		m.renderEnd(pt2.id, 'commit');
		expect(w.lastRenderedValue).toBe(2); // committed DOM never wedges at 1
		m.settleAction(t.id);
		selfCheck(m);
	});

	it('S35/S36 — reconcile at per-root advances (not just retirements), surviving slot release', () => {
		const m = concurrent();
		const flag = m.atom('flag', 0);
		const a = m.atom('a', 0);
		const b = m.atom('b', 0);
		const c = m.computed('c', (read) => (read(flag) ? read(a) : read(b)));
		const w = mountCommitted(m, 'A', c, 'W');
		const k = m.openBatch('deferred', { action: true }); // parked K
		m.write(k.id, flag, set(1)); // walk reaches W
		const pk = openRender(m, 'A', [k]); // K's render pins…
		m.renderWatcher(pk.id, w.id);
		m.renderYield(pk.id); // …and yields
		const d = m.openBatch('default');
		m.write(d.id, a, set(1)); // store-only default writes a (no committed edge a→c yet)
		m.retire(d.id); // and retires; its slot releases immediately (S36's freed-slot half)
		expect(m.eventsOfType('slot-released').some((e) => e.batch === d.id)).toBe(true);
		m.renderResume(pk.id);
		m.renderEnd(pk.id, 'commit'); // commits, locking K: committed-for-A = flag 1 (member), a 1 (retired) → c=1
		// the render itself rendered c=0 (its pin predates D); the ADVANCE must correct it now,
		// not at K's io-gated retirement
		expect(w.lastRenderedValue).toBe(1);
		const corrections = m.eventsOfType('reconcile-correction').filter((e) => e.watcher === 'W' && e.cause === 'per-root-commit');
		expect(corrections).toHaveLength(1);
		m.settleAction(k.id);
		selfCheck(m);
	});

	it('S38/S43 — quiescence requires synchronous WIP discard first; folds survive the episode reset', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(3));
		const p = openRender(m, 'A', [t]);
		m.renderYield(p.id);
		expect(() => m.quiesce()).toThrow(/quiescence requires/); // a live pin forbids the episode reset
		m.discardAllWip(); // a synchronous capability of the external-runtime protocol
		expect(m.livePins()).toHaveLength(0);
		m.retire(t.id);
		m.quiesce(); // discard-first, then reset: no post-reset stamp can land below a live pin
		expect(m.committedValue(a, 'A')).toBe(3);
		selfCheck(m);
	});

	it('S43 — corrective-covered divergence with a FAILING fast-out still corrects urgently (the covered check may not become the rule)', () => {
		// The mount fixup's ordinary compare corrects to committed-now even when
		// the divergence is "covered" by a scheduled corrective in the batch's
		// own lane: root A LOCKED the batch at this very commit, so its
		// committed truth already shows the post-pin write — painting the
		// pin-old value until the transition lane commits later would tear
		// against the root's own committed world. Pins the reviewer-contested
		// schedule that makes "always use the covered check instead of the
		// compare" observably WRONG (the covered value equals the rendered
		// value here, so a covered-check rule would suppress the correction).
		const m = concurrent();
		const a = m.atom('a', 0);
		const k = m.openBatch('deferred', { action: true }); // spanning transition, stays live
		m.write(k.id, a, set(1)); // pre-pin
		const p = openRender(m, 'A', [k]);
		const w = m.mountWatcher(p.id, a, 'W'); // renders the render world: 1
		expect(w.lastRenderedValue).toBe(1);
		m.write(k.id, a, set(2)); // post-pin write in the SAME rendered batch
		m.renderEnd(p.id, 'commit'); // locks k into A: committed-now folds a=2; the fast-out's clocks are loud
		expect(m.eventsOfType('mount-urgent-correction').filter((e) => e.watcher === 'W')).toHaveLength(1);
		expect(w.lastRenderedValue).toBe(2); // urgent pre-paint correction to committed-now
		expect(m.committedValue(a, 'A')).toBe(2);
		m.settleAction(k.id);
		selfCheck(m);
	});

	it('S42 — own-commit-neutral fast-outs need the population gate: reveal mounts take the compare', () => {
		const m = concurrent();
		const a = m.atom('a', 0);
		const f = m.computed('f', (read) => read(a));
		const hidden = openRender(m, 'A', []); // Activity pre-renders hidden W (pin p1, mask ∅)
		const w = m.mountWatcher(hidden.id, f, 'W');
		m.deferMountEffects(w.id); // effects deferred
		m.renderEnd(hidden.id, 'commit');
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(1)); // one event writes a@s2 > p1 and reveals
		const pu = openRender(m, 'A', [u]); // u's render bails on the pre-rendered W (not re-rendered)
		m.adoptRevealedMount(pu.id, w.id);
		m.renderEnd(pu.id, 'commit', { retireAtCommit: [u.id] }); // u's commit folds u post-baseline
		// without conjunct 0 the fast-out returns and V paints f(1) beside W's f(0);
		// the render-id gate forces the compare, which corrects pre-paint
		expect(m.eventsOfType('mount-urgent-correction').filter((e) => e.watcher === 'W')).toHaveLength(1);
		expect(w.lastRenderedValue).toBe(1);
		selfCheck(m);
	});
});
