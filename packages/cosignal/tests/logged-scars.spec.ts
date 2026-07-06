// TWIN RUN — this spec runs against the reference model (`cosignal-oracle`)
// AND the LOGGED engine at once: ./helpers.js here is the twin driver (model
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
import { commitAndRetire, logged, mountCommitted, pass, selfCheck, set, update } from './helpers.js';

describe('pinned scars (model-expressible)', () => {
	it('S1 — no-log urgent writes: urgent ×2 over pending +1 commits 2 then 4, never 3', () => {
		const m = logged();
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
		const m = logged();
		const flag = m.atom('flag', 0);
		const a = m.atom('a', 0);
		const b = m.atom('b', 0);
		const c = m.computed('c', (read) => (read(flag) ? read(a) : read(b)));
		mountCommitted(m, 'A', c, 'W');
		const k = m.openBatch('deferred');
		m.write(k.id, flag, set(1));
		const pk = pass(m, 'A', [k]);
		expect(m.passValue(c, pk)).toBe(0); // the k-world evaluation records the REAL dep a→c
		m.write(k.id, a, set(1)); // committed topology has no a→c edge — the trap
		// the watcher IS notified in k's lane (interleaved: pass open, pin < seq)
		const kDeliveries = m.eventsOfType('delivery').filter((e) => e.watcher === 'W' && e.token === k.id);
		expect(kDeliveries.length).toBeGreaterThanOrEqual(2);
		m.passEnd(pk.id, 'discard');
		const pk2 = pass(m, 'A', [k]);
		expect(m.passValue(c, pk2)).toBe(1); // no stale forever-cache
		expect(m.committedValue(c, 'A')).toBe(0);
		m.passEnd(pk2.id, 'commit', { retireAtCommit: [k.id] });
		selfCheck(m);
	});

	it('S4 — drop-on-abort retirement: committed=false batches fold; writes never silently revert', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(5)); // no subscriber → no React work → committed=false
		m.retire(t.id, false);
		expect(m.committedValue(a, 'A')).toBe(5); // persistence must never depend on subscription
		selfCheck(m);
	});

	it('S5 — eval-time-only validity: an atom acquiring its first receipt AFTER a world read still invalidates', () => {
		const m = logged();
		const a = m.atom('a', 0); // unlogged when world-k first reads it
		const c = m.computed('c', (read) => (read(a) as number) + 1);
		const k = m.openBatch('deferred');
		m.write(k.id, m.atom('warm', 0), set(1)); // k exists with unrelated state
		const pk = pass(m, 'A', [k]);
		expect(m.passValue(c, pk)).toBe(1); // first read: a has no tape
		m.passEnd(pk.id, 'discard');
		m.write(k.id, a, set(9)); // a acquires a tape only now
		const pk2 = pass(m, 'A', [k]);
		expect(m.passValue(c, pk2)).toBe(10); // a fresh k render must see it (no stale certificate)
		m.passEnd(pk2.id, 'discard');
		m.retire(k.id, false);
		selfCheck(m);
	});

	it('S6 — machinery keyed to watcher count: pre-bridge writes are committed-only state', () => {
		const m = logged(); // fresh model, then simulate the pre-bridge era on a second model
		void m;
		const m2 = new (Object.getPrototypeOf(m).constructor)() as typeof m;
		const a = m2.atom('a', 0);
		m2.write(undefined, a, set(1)); // DIRECT write: no receipt (bridge not registered)
		expect(a.tape).toHaveLength(0);
		expect(a.base).toBe(1);
		m2.registerBridge(); // activation is monotonic on registration, not on first watcher
		const c = m2.computed('c', (read) => read(a));
		const w = mountCommitted(m2, 'A', c, 'W');
		expect(w.lastRenderedValue).toBe(1); // committed-only value; urgent renders cannot leak a "transition"
		const sync = pass(m2, 'A', []);
		expect(m2.passValue(c, sync)).toBe(1);
		m2.passEnd(sync.id, 'commit');
		selfCheck(m2);
	});

	it('S7 — wall-clock render scopes: a yield-gap write neither throws nor lands in the pass', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1));
		const p = pass(m, 'A', [t]);
		m.passYield(p.id);
		const u = m.openBatch('urgent');
		expect(() => m.write(u.id, a, set(2))).not.toThrow(); // per-callstack truth: not in render
		expect(m.newestValue(a)).toBe(2); // gap reads resolve NEWEST, not the pin
		m.passResume(p.id);
		expect(m.passValue(a, p)).toBe(1); // and the pass never sees it
		m.passEnd(p.id, 'discard');
		m.retire(t.id, false);
		m.retire(u.id, true);
		selfCheck(m);
	});

	it('S8 — equality-gating writes against newest: U set(1) after T set(1) still appends', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1));
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(1)); // equal to newest — the scarred design dropped it
		const pu = pass(m, 'A', [u]);
		expect(m.passValue(a, pu)).toBe(1); // U's render excludes T and must still show 1, not 0
		m.passEnd(pu.id, 'commit', { retireAtCommit: [u.id] });
		m.retire(t.id, false); // even if T dies, U's receipt independently commits 1
		expect(m.committedValue(a, 'A')).toBe(1);
		selfCheck(m);
	});

	it('S9 — unflagged ⇒ serve-anything routing: a never-evaluated node cannot leak pending state', () => {
		const m = logged();
		const a = m.atom('a', 0);
		// quiesce-fresh model; c has never been evaluated anywhere (no edges, no marks)
		const c = m.computed('c', (read) => (read(a) as number) + 1);
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(9)); // write to an atom with no out-edges yet
		const sync = pass(m, 'A', []); // urgent pass reads the never-evaluated node
		expect(m.passValue(c, sync)).toBe(1); // committed world, never 10 (a torn urgent frame)
		m.passEnd(sync.id, 'commit');
		m.retire(k.id, false);
		selfCheck(m);
	});

	it('S10 — equality-filtered late-join correction: subset divergence needs value-blind correctives', () => {
		const m = logged();
		const x1 = m.atom('x1', 0);
		const x2 = m.atom('x2', 0);
		const c = m.computed('c', (read) => ((read(x1) as number) && (read(x2) as number)) as number);
		const t1 = m.openBatch('deferred');
		const t2 = m.openBatch('deferred');
		m.write(t1.id, x1, set(1)); // per-token projection: 1&&0 = 0 == committed
		m.write(t2.id, x2, set(1)); // per-token projection: 0&&1 = 0 == committed
		const p = pass(m, 'A', []); // mount excludes both
		const w = m.mountWatcher(p.id, c, 'W');
		expect(w.lastRenderedValue).toBe(0);
		m.passEnd(p.id, 'commit');
		// equality-filtered designs skipped both correctives (all projections equal committed);
		// value-blind fixup schedules BOTH runInBatch correctives
		const corr = m.eventsOfType('mount-corrective').filter((e) => e.watcher === 'W');
		expect(corr.map((e) => e.token).sort()).toEqual([t1.id, t2.id].sort());
		// joint render {t1,t2} then shows 1 — no torn committed frame
		const pj = pass(m, 'A', [t1, t2]);
		m.renderWatcher(pj.id, w.id);
		m.passEnd(pj.id, 'commit', { retireAtCommit: [t1.id, t2.id] });
		expect(w.lastRenderedValue).toBe(1);
		selfCheck(m);
	});

	it('S11/S12 — mid-pass retirement on another root: the resumed pass folds at its pin, always', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const n = m.computed('n', (read) => (read(a) as number) + 10);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1));
		const p = pass(m, 'B', [t]); // pass on root B
		m.passYield(p.id);
		const d = m.openBatch('default');
		m.write(d.id, a, set(7));
		m.retire(d.id, true); // retires mid-yield (work on another root / store-only)
		m.passResume(p.id);
		// FIRST read of a not-yet-read node after resume: fullyRetired-at-read-time designs leak 7
		expect(m.passValue(n, p)).toBe(11); // pin excludes the mid-yield retirement
		expect(m.passValue(a, p)).toBe(1); // no sibling disagreement inside one tree
		m.passEnd(p.id, 'commit', { retireAtCommit: [t.id] });
		expect(m.committedValue(a, 'A')).toBe(7); // replay by seq: set1 then set7
		selfCheck(m);
	});

	it('S14 — canonical-equal write gating cross-world invalidation: delivery and worlds still move', () => {
		const m = logged();
		const a = m.atom('a', 3);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const t = m.openBatch('deferred');
		m.write(t.id, a, update((x) => (x as number) + 1)); // T-world 4, newest 4
		const pt = pass(m, 'A', [t]);
		m.renderWatcher(pt.id, w.id); // T rendered (finished-uncommitted below)
		m.passYield(pt.id);
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(4)); // equal to CANONICAL (newest 4): the dead design saw "kernel value unchanged" and gated invalidation on it
		// delivery fires anyway — value-blind (interleaved for W: T's pass is open, pin < seq)
		expect(m.eventsOfType('delivery').filter((e) => e.watcher === 'W' && e.token === u.id)).toHaveLength(1);
		commitAndRetire(m, 'B', u);
		m.passResume(pt.id);
		m.passEnd(pt.id, 'discard'); // interleaved update forces the restart
		const pt2 = pass(m, 'A', [t]);
		expect(m.passValue(c, pt2)).toBe(4); // replay by seq: +1@s1 → 4, then retired set(4)@s2 → 4
		m.passEnd(pt2.id, 'commit', { retireAtCommit: [t.id] });
		expect(m.committedValue(c, 'A')).toBe(4); // T's world moved with the urgent write; nothing stale committed
		selfCheck(m);
	});

	it('S16 — value-based delivery suppression: a T-segment write returning c to committed still delivers', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1)); // T renders c=1
		const pt = pass(m, 'A', [t]);
		m.renderWatcher(pt.id, w.id);
		m.passYield(pt.id); // finished-but-uncommitted
		const mark = m.events.length;
		m.write(t.id, a, set(0)); // returns c to 0 == committed lastRendered 0 — the dead cutoff suppressed this
		const late = m.eventsSince(mark).filter((e) => e.type === 'delivery' && e.watcher === 'W' && e.token === t.id);
		expect(late).toHaveLength(1); // delivered (bit re-armed at W's render); the stale finished subtree never commits as-is
		m.passResume(pt.id);
		m.passEnd(pt.id, 'discard');
		const pt2 = pass(m, 'A', [t]);
		m.renderWatcher(pt2.id, w.id);
		m.passEnd(pt2.id, 'commit', { retireAtCommit: [t.id] });
		expect(w.lastRenderedValue).toBe(0);
		selfCheck(m);
	});

	it('S17 — shared per-node walk stamps: interleaved batches never prune each other\'s deliveries', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const k = m.openBatch('deferred');
		const j = m.openBatch('deferred');
		m.write(k.id, a, set(1)); // k delivers through c
		const pk = pass(m, 'A', [k]);
		m.renderWatcher(pk.id, w.id); // W re-arms k
		m.passEnd(pk.id, 'commit');
		m.write(j.id, a, set(2)); // j's walk "overwrites the shared stamp" in the dead design
		m.write(k.id, a, set(3)); // k's next write must still deliver
		const kD = m.eventsOfType('delivery').filter((e) => e.watcher === 'W' && e.token === k.id);
		expect(kD.length).toBeGreaterThanOrEqual(2); // initial + post-re-arm delivery
		m.retire(k.id, true);
		m.retire(j.id, false);
		selfCheck(m);
	});

	it('S18 — pinless shared world memos: two live pins always get their own answers', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => (read(a) as number) * 10);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(1));
		const pIn = pass(m, 'A', [t]); // includes T
		const pOut = pass(m, 'B', []); // excludes T, different pin
		expect(m.passValue(c, pIn)).toBe(10);
		expect(m.passValue(c, pOut)).toBe(0); // simultaneously — no shared-slot overwrite possible
		m.write(t.id, a, set(2)); // post-pin for both
		expect(m.passValue(c, pIn)).toBe(10); // each pass keeps ITS pinned world
		expect(m.passValue(c, pOut)).toBe(0);
		m.passEnd(pIn.id, 'discard');
		m.passEnd(pOut.id, 'discard');
		m.retire(t.id, false);
		selfCheck(m);
	});

	it('S19a — late write on a committed-but-live action: membership-visible plus a corrective, urgent-bounded', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const t = m.openBatch('deferred', { action: true });
		m.scopeWrite(t.id, a, set(1));
		const pA = pass(m, 'A', [t]);
		m.renderWatcher(pA.id, w.id);
		m.passEnd(pA.id, 'commit'); // A commits T (lock-in); T parks on, still live
		expect(w.lastRenderedValue).toBe(1);
		const mark = m.events.length;
		m.scopeWrite(t.id, a, set(2)); // post-await, post-commit scope write
		// visible to A's committed world immediately (the committed world closes
		// over every write of a token the root committed)…
		expect(m.committedValue(c, 'A')).toBe(2);
		// …and the corrective (the value-blind delivery in T's own lane) is scheduled
		const corr = m.eventsSince(mark).filter((e) => e.type === 'delivery' && e.watcher === 'W' && e.token === t.id);
		expect(corr).toHaveLength(1);
		const pA2 = pass(m, 'A', [t]); // the corrective render in the batch's own lanes
		m.renderWatcher(pA2.id, w.id);
		m.passEnd(pA2.id, 'commit');
		expect(w.lastRenderedValue).toBe(2); // bounded window, closed
		m.settleAction(t.id, true);
		selfCheck(m);
	});

	it('S21/S25 — ambient classification after await: the raw write is default-batched and commits first', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred', { action: true });
		m.write(t.id, a, set(1)); // sync prefix
		m.bareWrite(a, set(2)); // timer/continuation on a bare stack (the post-await lint is adapter-only)
		const ambient = m.tokens.get(m.ambientToken!)!;
		expect(ambient.priority).toBe('default');
		m.retire(ambient.id, true);
		expect(m.committedValue(a, 'A')).toBe(2); // commits before the action settles — matching React's own async-action rule
		m.settleAction(t.id, true);
		expect(m.committedValue(a, 'A')).toBe(2); // write order wins at the fold
		selfCheck(m);
	});

	it('S23 — evaluator identity: fresh nodes per closure; a pass world never sees another closure\'s output', () => {
		const m = logged();
		const a = m.atom('a', 1);
		const cOld = m.computed('cOld', (read) => (read(a) as number) + 100);
		const cNew = m.computed('cNew', (read) => (read(a) as number) + 200); // deps-keyed recreation
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(2));
		const pIn = pass(m, 'A', [t]); // the pass holding the NEW node via its hook state
		const pOut = pass(m, 'B', []); // committed pass holds the OLD node
		expect(m.passValue(cNew, pIn)).toBe(202);
		expect(m.passValue(cOld, pOut)).toBe(101); // no evaluator swap can mix these
		m.passEnd(pIn.id, 'discard');
		m.passEnd(pOut.id, 'discard');
		m.retire(t.id, false);
		selfCheck(m);
	});

	it('S26 — consumable queues: a later advance re-runs the effect even after earlier unrelated drains', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const e = m.mountReactEffect('A', a, 'E');
		const k = m.openBatch('deferred', { action: true }); // parked
		m.scopeWrite(k.id, a, set(1));
		const x = m.openBatch('urgent');
		m.write(x.id, m.atom('unrelated', 0), set(1));
		m.retire(x.id, true); // an earlier unrelated retirement "consumes the queue entry"
		expect(e.runs).toBe(0); // k invisible to committed-for-A: correctly no run yet
		const pA = pass(m, 'A', [k]);
		m.passEnd(pA.id, 'commit'); // the later per-root advance exposes the parked write
		expect(e.runs).toBe(1); // durable enumeration: the advance itself drains
		expect(e.lastValue).toBe(1);
		m.settleAction(k.id, true);
		selfCheck(m);
	});

	it('S27 — empty-tape drops with immutable evaluators: identity update drops; real update appends', () => {
		// Re-pinned for the shrunk op vocabulary: a ReducerAtom dispatch records
		// as an update whose closure captures the action, so the drop/append
		// rules are exercised through the closure form.
		const reduce = (s: unknown, act: string) => (act === 'inc' ? (s as number) + 1 : s);
		const m = logged();
		const r = m.atom('r', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, r, update((s) => reduce(s, 'noop'))); // evaluates equal against base → legal drop
		expect(m.eventsOfType('write-dropped')).toHaveLength(1);
		expect(r.tape).toHaveLength(0);
		m.write(t.id, r, update((s) => reduce(s, 'inc'))); // 1 ≠ 0 → append
		expect(r.tape).toHaveLength(1);
		m.write(t.id, r, update((s) => reduce(s, 'noop'))); // tape non-empty → ALWAYS append (equality lives at fold time)
		expect(r.tape).toHaveLength(2);
		commitAndRetire(m, 'A', t);
		expect(m.committedValue(r, 'A')).toBe(1);
		selfCheck(m);
	});

	it('S29a — retirement-time mark clearing: the resumed pass reads ONE world (computed and atom agree)', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const n = m.computed('n', (read) => (read(a) as number) + 11);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(100)); // T so the pass has a mask
		const p = pass(m, 'B', [t]);
		m.passYield(p.id);
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(1));
		m.retire(u.id, true); // clears-at-retire designs then serve kernel n=12 beside folded a=100
		m.passResume(p.id);
		expect(m.passValue(a, p)).toBe(100);
		expect(m.passValue(n, p)).toBe(111); // same world — no torn frame
		m.passEnd(p.id, 'discard');
		m.retire(t.id, false);
		selfCheck(m);
	});

	it('S29b — the dual (unbounded retention) and the full-table backstop corner, loud and safe', () => {
		const m = logged();
		const a = m.atom('a', 0);
		// a yielded pass whose mask names 5 batches that all retire mid-pass
		const retained = Array.from({ length: 5 }, () => m.openBatch('deferred'));
		for (const [i, t] of retained.entries()) m.write(t.id, a, update((x) => (x as number) + 10 ** 0 * (i + 1)));
		const held = pass(m, 'B', retained);
		m.passYield(held.id);
		const heldBefore = m.passValue(a, held);
		for (const t of retained) m.retire(t.id, true); // entangled lanes: work lived on other roots
		expect(m.slots.filter((s) => s.releasePending)).toHaveLength(5); // mask-retained
		// fresh live batches demand slots: 26 free + 5 retained = table full at the 27th claim
		const live: number[] = [];
		for (let i = 0; i < 27; i++) {
			const u = m.openBatch('urgent');
			live.push(u.id);
			m.write(u.id, a, set(i));
		}
		expect(m.eventsOfType('slot-backstop-released')).toHaveLength(1); // loud
		// safe: the retained pass's receipts keep their slot fields and stay clause-2 visible below its pin
		expect(m.passValue(a, held)).toBe(heldBefore);
		m.passResume(held.id);
		m.passEnd(held.id, 'discard');
		for (const id of live) m.retire(id, true);
		selfCheck(m);
	});

	it('S30 — transitive-chain delivery still works after episode reset (cone-carry outcome)', () => {
		const m = logged();
		const x = m.atom('x', 0);
		const u = m.computed('u', (read) => (read(x) as number) + 1);
		const wNode = m.computed('w', (read) => (read(u) as number) + 1);
		const watcher = mountCommitted(m, 'A', wNode, 'W');
		const t0 = m.openBatch('deferred');
		m.write(t0.id, x, set(1));
		commitAndRetire(m, 'A', t0, [watcher]);
		m.quiesce(); // episode reset: edges cleared, counters keep climbing
		const k = m.openBatch('deferred');
		const mark = m.events.length;
		m.write(k.id, x, set(2)); // next episode's write must reach the watcher through x→u→w
		const d = m.eventsSince(mark).filter((e) => e.type === 'delivery' && e.watcher === 'W');
		expect(d).toHaveLength(1);
		m.retire(k.id, true);
		selfCheck(m);
	});

	it('S33 — dedup re-armed only at render: the pass-aware rule delivers the post-pin same-slot write', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => read(a));
		const w = mountCommitted(m, 'A', c, 'W');
		const t = m.openBatch('deferred', { action: true });
		m.scopeWrite(t.id, a, set(1)); // bit set, setState delivered
		expect(w.dedup.size).toBe(1);
		const pt = pass(m, 'A', [t]); // T's pass pins and yields BEFORE the watcher renders
		m.passYield(pt.id);
		const mark = m.events.length;
		m.scopeWrite(t.id, a, set(2)); // carried continuation writes post-pin
		// the dead design suppressed the only setState; the pass-aware rule delivers interleaved
		const d = m.eventsSince(mark).filter((e) => e.type === 'delivery' && e.watcher === 'W' && e.token === t.id);
		expect(d).toHaveLength(1);
		expect(d[0]!.type === 'delivery' && d[0]!.mode).toBe('interleaved');
		m.passResume(pt.id);
		m.passEnd(pt.id, 'discard'); // React restarts at a fresh pin for the interleaved update
		const pt2 = pass(m, 'A', [t]);
		m.renderWatcher(pt2.id, w.id);
		m.passEnd(pt2.id, 'commit');
		expect(w.lastRenderedValue).toBe(2); // committed DOM never wedges at 1
		m.settleAction(t.id, true);
		selfCheck(m);
	});

	it('S35/S36 — reconcile at per-root advances (not just retirements), surviving slot release', () => {
		const m = logged();
		const flag = m.atom('flag', 0);
		const a = m.atom('a', 0);
		const b = m.atom('b', 0);
		const c = m.computed('c', (read) => (read(flag) ? read(a) : read(b)));
		const w = mountCommitted(m, 'A', c, 'W');
		const k = m.openBatch('deferred', { action: true }); // parked K
		m.scopeWrite(k.id, flag, set(1)); // walk reaches W
		const pk = pass(m, 'A', [k]); // K's pass pins…
		m.renderWatcher(pk.id, w.id);
		m.passYield(pk.id); // …and yields
		const d = m.openBatch('default');
		m.write(d.id, a, set(1)); // store-only default writes a (no committed edge a→c yet)
		m.retire(d.id, false); // and retires; its slot releases immediately (S36's freed-slot half)
		expect(m.eventsOfType('slot-released').some((e) => e.token === d.id)).toBe(true);
		m.passResume(pk.id);
		m.passEnd(pk.id, 'commit'); // commits, locking K: committed-for-A = flag 1 (member), a 1 (retired) → c=1
		// the pass itself rendered c=0 (its pin predates D); the ADVANCE must correct it now,
		// not at K's io-gated retirement
		expect(w.lastRenderedValue).toBe(1);
		const corrections = m.eventsOfType('reconcile-correction').filter((e) => e.watcher === 'W' && e.cause === 'per-root-commit');
		expect(corrections).toHaveLength(1);
		m.settleAction(k.id, true);
		selfCheck(m);
	});

	it('S38/S43 — quiescence requires synchronous WIP discard first; folds survive the episode reset', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred');
		m.write(t.id, a, set(3));
		const p = pass(m, 'A', [t]);
		m.passYield(p.id);
		expect(() => m.quiesce()).toThrow(/quiescence requires/); // a live pin forbids the episode reset
		m.discardAllWip(); // a synchronous capability of the external-runtime protocol
		expect(m.livePins()).toHaveLength(0);
		m.retire(t.id, true);
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
		const m = logged();
		const a = m.atom('a', 0);
		const k = m.openBatch('deferred', { action: true }); // spanning transition, stays live
		m.scopeWrite(k.id, a, set(1)); // pre-pin
		const p = pass(m, 'A', [k]);
		const w = m.mountWatcher(p.id, a, 'W'); // renders the pass world: 1
		expect(w.lastRenderedValue).toBe(1);
		m.scopeWrite(k.id, a, set(2)); // post-pin write in the SAME rendered batch
		m.passEnd(p.id, 'commit'); // locks k into A: committed-now folds a=2; the fast-out's clocks are loud
		expect(m.eventsOfType('mount-urgent-correction').filter((e) => e.watcher === 'W')).toHaveLength(1);
		expect(w.lastRenderedValue).toBe(2); // urgent pre-paint correction to committed-now
		expect(m.committedValue(a, 'A')).toBe(2);
		m.settleAction(k.id, true);
		selfCheck(m);
	});

	it('S42 — own-commit-neutral fast-outs need the population gate: reveal mounts take the compare', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const f = m.computed('f', (read) => read(a));
		const hidden = pass(m, 'A', []); // Activity pre-renders hidden W (pin p1, mask ∅)
		const w = m.mountWatcher(hidden.id, f, 'W');
		m.deferMount(w.id); // effects deferred
		m.passEnd(hidden.id, 'commit');
		const u = m.openBatch('urgent');
		m.write(u.id, a, set(1)); // one event writes a@s2 > p1 and reveals
		const pu = pass(m, 'A', [u]); // u's render bails on the pre-rendered W (not re-rendered)
		m.adoptMount(pu.id, w.id);
		m.passEnd(pu.id, 'commit', { retireAtCommit: [u.id] }); // u's commit folds u post-baseline
		// without conjunct 0 the fast-out returns and V paints f(1) beside W's f(0);
		// the pass-id gate forces the compare, which corrects pre-paint
		expect(m.eventsOfType('mount-urgent-correction').filter((e) => e.watcher === 'W')).toHaveLength(1);
		expect(w.lastRenderedValue).toBe(1);
		selfCheck(m);
	});
});
