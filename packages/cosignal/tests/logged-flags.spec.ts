// TWIN RUN — the oracle spec below runs VERBATIM against the LOGGED engine:
// ./helpers.js here is the twin driver (model + engine fan-out; every read is
// parity-asserted; selfCheck compares events/snapshots and runs the invariant
// battery on BOTH sides). Source: packages/cosignal-oracle/tests/flags.spec.ts.
/**
 * Appendix B editorial flags — the model-checkable ones (3, 4, 5, 7), each
 * as a targeted test. Findings and discrepancies: tests/FLAGS.md.
 */
import { describe, expect, it } from 'vitest';
import { logged, mountCommitted, pass, selfCheck, set, update } from './helpers.js';

describe('flag 3 — write-set closure at commit (ActionScope late-write surface)', () => {
	it('a late scope write on a committed, live token is membership-visible, corrected, and lifecycle-clean', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const w = mountCommitted(m, 'A', a, 'W');
		const t = m.openBatch('deferred', { action: true });
		m.scopeWrite(t.id, a, set(1));
		const pA = pass(m, 'A', [t]);
		m.renderWatcher(pA.id, w.id);
		m.passEnd(pA.id, 'commit'); // A commits t; t parks on (live)
		expect(m.roots.get('A')!.committedTokens.has(t.id)).toBe(true);
		m.scopeWrite(t.id, a, set(2)); // the surviving late-write surface
		expect(m.committedValue(a, 'A')).toBe(2); // visible immediately via the membership clause (§5.3)
		// the corrective rides the batch's own lanes (value-blind delivery to A's watchers)
		expect(m.eventsOfType('delivery').filter((e) => e.watcher === 'W' && e.token === t.id).length).toBeGreaterThanOrEqual(1);
		// slot-lifecycle side is clean: a committed-but-live token cannot release its slot
		expect(m.tokens.get(t.id)!.slot).toBeDefined();
		expect(m.eventsOfType('slot-released').filter((e) => e.token === t.id)).toHaveLength(0);
		m.settleAction(t.id, true); // rows clear at retirement, before release (§5.3 step 5)
		expect(m.roots.get('A')!.committedTokens.has(t.id)).toBe(false);
		expect(m.eventsOfType('slot-released').filter((e) => e.token === t.id)).toHaveLength(1);
		selfCheck(m);
	});
});

describe('flag 4 — pass-world membership pin cap (slot ∈ capturedCommitted ∧ seq ≤ pin)', () => {
	it('a committed-member token writing post-pin cannot drift a yielded pass\'s world', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const t = m.openBatch('deferred', { action: true });
		m.scopeWrite(t.id, a, set(1));
		const pA = pass(m, 'A', [t]);
		m.passEnd(pA.id, 'commit'); // A's committed set now holds t (still live, parked)
		const p2 = pass(m, 'A', []); // mask ∅, capturedCommitted ∋ slot(t)
		expect(m.passValue(a, p2)).toBe(1); // membership admits the pre-pin write
		m.passYield(p2.id);
		m.scopeWrite(t.id, a, set(9)); // committed-member write AFTER p2's pin
		m.passResume(p2.id);
		// WITHOUT the editorial pin cap, clause 2 would admit seq > pin and the
		// yielded pass's world would drift mid-render. With it: stable.
		expect(m.passValue(a, p2)).toBe(1);
		// the write is not lost: it is committed-visible at now and at the next pin
		expect(m.committedValue(a, 'A')).toBe(9);
		m.passEnd(p2.id, 'commit');
		const p3 = pass(m, 'A', []);
		expect(m.passValue(a, p3)).toBe(9);
		m.passEnd(p3.id, 'commit');
		m.settleAction(t.id, true);
		selfCheck(m);
	});
});

describe('flag 5 — fixup fast-out conjunct set (four conjuncts, population gate)', () => {
	// The soundness half is asserted INSIDE the model: mountFixup throws
	// InvariantViolation whenever the four conjuncts hold but v_fx ≠ v_r.
	// Every battery/scars/fuzz mount exercises that assert.
	it('quiet in-pass mount takes the fast-out: zero corrections, zero drift', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const c = m.computed('c', (read) => (read(a) as number) + 1);
		const k = m.openBatch('deferred');
		m.write(k.id, a, set(4));
		const pk = pass(m, 'A', [k]);
		const w = m.mountWatcher(pk.id, c, 'W');
		m.passEnd(pk.id, 'commit'); // all four conjuncts hold
		expect(m.eventsOfType('mount-corrective')).toHaveLength(0);
		expect(m.eventsOfType('mount-urgent-correction')).toHaveLength(0);
		expect(w.lastRenderedValue).toBe(5);
		m.retire(k.id, true);
		selfCheck(m);
	});

	it('each dropped conjunct admits a counterexample: foreign cas motion falls through and fires', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const k = m.openBatch('deferred');
		const pk = pass(m, 'A', [k]);
		const w = m.mountWatcher(pk.id, a, 'W');
		m.passYield(pk.id);
		const d = m.openBatch('default'); // foreign committed-side motion in the window
		m.write(d.id, a, set(3));
		m.retire(d.id, false);
		m.passResume(pk.id);
		m.passEnd(pk.id, 'commit');
		// conjunct 1 (baseline.cas ≤ pin) fails ⇒ compare ⇒ value-true correction
		expect(m.eventsOfType('mount-urgent-correction').filter((e) => e.watcher === 'W')).toHaveLength(1);
		expect(w.lastRenderedValue).toBe(3);
		m.retire(k.id, false);
		selfCheck(m);
	});
});

describe('flag 7 — backstop without the pass flag (keep-the-dirt disposal)', () => {
	it('after a forced release, the retained pass still folds its world exactly (receipts carry slots)', () => {
		const m = logged();
		const a = m.atom('a', 0);
		const retained = Array.from({ length: 5 }, () => m.openBatch('deferred'));
		for (const t of retained) m.write(t.id, a, update((x) => (x as number) + 1));
		const held = pass(m, 'B', retained); // mask names all five
		m.passYield(held.id);
		expect(m.passValue(a, held)).toBe(5);
		for (const t of retained) m.retire(t.id, true); // all retire mid-pass; releases defer
		const live: number[] = [];
		for (let i = 0; i < 27; i++) {
			const u = m.openBatch('urgent');
			live.push(u.id);
			m.write(u.id, a, set(100 + i)); // 27th claim forces the backstop
		}
		expect(m.eventsOfType('slot-backstop-released')).toHaveLength(1);
		// flag-free safety: the victim's receipts keep their slot field and stay
		// clause-2 visible below the held pin; the new tenant's sequences postdate it
		expect(m.passValue(a, held)).toBe(5);
		// and the new tenant's own world folds the recycled slot's history in seq order
		const lastLive = m.tokens.get(live[live.length - 1]!)!;
		const q = pass(m, 'A', [lastLive]);
		expect(m.passValue(a, q)).toBe(126); // 5 retired +1s → 5, then the last set(126)
		m.passEnd(q.id, 'discard');
		m.passResume(held.id);
		m.passEnd(held.id, 'discard');
		for (const id of live) m.retire(id, true);
		selfCheck(m);
	});
});
