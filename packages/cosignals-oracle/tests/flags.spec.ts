/**
 * Targeted tests for the subtle behavioral rules documented in
 * tests/FLAGS.md — the model-checkable ones. The ids (flag 3, flag 4,
 * flag 5, flag 7) are stable identifiers shared with that document; the
 * numbering is historical. In one line each:
 *   flag 3  a committed-but-still-live async action's late write is
 *           committed-visible immediately and corrected in its own lane
 *   flag 4  a render world admits included-batch writes only up to its pin,
 *           so a paused render never drifts
 *   flag 5  the mount-reconciliation fast path: when it may skip the
 *           comparison, and why it is sound only with the corrective loop
 *   flag 7  a forced release of a retained slot changes no world's answer
 */
import { describe, expect, it } from 'vitest'
import { concurrent, mountCommitted, openRender, selfCheck, set, update } from './helpers.js'

describe('flag 3 — write-set closure at commit (late member-write surface)', () => {
	it('a late member write on a committed, live batch is membership-visible, corrected, and lifecycle-clean', () => {
		const m = concurrent()
		const a = m.atom('a', 0)
		const w = mountCommitted(m, 'A', a, 'W')
		const t = m.openBatch({ action: true })
		m.write(t.id, a, set(1))
		const pA = openRender(m, 'A', [t])
		m.renderWatcher(pA.id, w.id)
		m.renderEnd(pA.id, 'commit') // A commits t; t parks on (live)
		expect(m.roots.get('A')!.committedBatches.has(t.id)).toBe(true)
		m.write(t.id, a, set(2)) // the surviving late-write surface
		expect(m.committedValue(a, 'A')).toBe(2) // visible immediately via membership (A committed t)
		// the corrective rides the batch's own lanes (value-blind delivery to A's watchers)
		expect(
			m.eventsOfType('delivery').filter((e) => e.watcher === 'W' && e.batch === t.id).length,
		).toBeGreaterThanOrEqual(1)
		// slot-lifecycle side is clean: a committed-but-live batch cannot release its slot
		expect(m.idToBatch.get(t.id)!.slot).toBeDefined()
		expect(m.eventsOfType('slot-released').filter((e) => e.batch === t.id)).toHaveLength(0)
		m.settleAction(t.id) // membership rows clear at retirement, strictly before slot release
		expect(m.roots.get('A')!.committedBatches.has(t.id)).toBe(false)
		expect(m.eventsOfType('slot-released').filter((e) => e.batch === t.id)).toHaveLength(1)
		selfCheck(m)
	})
})

describe('flag 4 — render-world membership pin cap (slot ∈ capturedCommitted ∧ seq ≤ pin)', () => {
	it("a committed-member batch writing post-pin cannot drift a yielded render's world", () => {
		const m = concurrent()
		const a = m.atom('a', 0)
		const t = m.openBatch({ action: true })
		m.write(t.id, a, set(1))
		const pA = openRender(m, 'A', [t])
		m.renderEnd(pA.id, 'commit') // A's committed set now holds t (still live, parked)
		const p2 = openRender(m, 'A', []) // mask ∅, capturedCommitted ∋ slot(t)
		expect(m.renderValue(a, p2)).toBe(1) // membership admits the pre-pin write
		m.renderYield(p2.id)
		m.write(t.id, a, set(9)) // committed-member write AFTER p2's pin
		m.renderResume(p2.id)
		// WITHOUT the editorial pin cap, clause 2 would admit seq > pin and the
		// yielded render's world would drift mid-render. With it: stable.
		expect(m.renderValue(a, p2)).toBe(1)
		// the write is not lost: it is committed-visible at now and at the next pin
		expect(m.committedValue(a, 'A')).toBe(9)
		m.renderEnd(p2.id, 'commit')
		const p3 = openRender(m, 'A', [])
		expect(m.renderValue(a, p3)).toBe(9)
		m.renderEnd(p3.id, 'commit')
		m.settleAction(t.id)
		selfCheck(m)
	})
})

describe('flag 5 — fixup fast-out conjunct set (four conjuncts, population gate)', () => {
	// Conditions-first: a passing four-condition test skips the fixup
	// evaluation and comparison entirely. The corrective loop is the test's
	// soundness premise (FLAGS.md flag 5 finding 3); battery cases 9/10 and
	// the fuzz corpus pin the observable behavior on both sides of the test.
	it('quiet in-render mount takes the fast-out: zero corrections, zero drift', () => {
		const m = concurrent()
		const a = m.atom('a', 0)
		const c = m.computed('c', (read) => (read(a) as number) + 1)
		const k = m.openBatch()
		m.write(k.id, a, set(4))
		const pk = openRender(m, 'A', [k])
		const w = m.mountWatcher(pk.id, c, 'W')
		m.renderEnd(pk.id, 'commit') // all four fast-path conditions hold
		expect(m.eventsOfType('mount-corrective')).toHaveLength(0)
		expect(m.eventsOfType('mount-urgent-correction')).toHaveLength(0)
		expect(w.lastRenderedValue).toBe(5)
		m.retire(k.id)
		selfCheck(m)
	})

	it('each dropped conjunct admits a counterexample: foreign committedAdvance motion falls through and fires', () => {
		const m = concurrent()
		const a = m.atom('a', 0)
		const k = m.openBatch()
		const pk = openRender(m, 'A', [k])
		const w = m.mountWatcher(pk.id, a, 'W')
		m.renderYield(pk.id)
		const d = m.openBatch() // foreign committed-side motion in the window
		m.write(d.id, a, set(3))
		m.retire(d.id)
		m.renderResume(pk.id)
		m.renderEnd(pk.id, 'commit')
		// the no-committed-advance condition fails ⇒ compare ⇒ value-true correction
		expect(m.eventsOfType('mount-urgent-correction').filter((e) => e.watcher === 'W')).toHaveLength(
			1,
		)
		expect(w.lastRenderedValue).toBe(3)
		m.retire(k.id)
		selfCheck(m)
	})
})

describe('flag 7 — backstop without the render flag (keep-the-dirt disposal)', () => {
	it('after a forced release, the retained render still folds its world exactly (log entries carry slots)', () => {
		const m = concurrent()
		const a = m.atom('a', 0)
		const retained = Array.from({ length: 5 }, () => m.openBatch())
		for (const t of retained)
			m.write(
				t.id,
				a,
				update((x) => (x as number) + 1),
			)
		const held = openRender(m, 'B', retained) // mask names all five
		m.renderYield(held.id)
		expect(m.renderValue(a, held)).toBe(5)
		for (const t of retained) m.retire(t.id) // all retire mid-render; releases defer
		const live: number[] = []
		for (let i = 0; i < 27; i++) {
			const u = m.openBatch()
			live.push(u.id)
			m.write(u.id, a, set(100 + i)) // 27th claim forces the backstop
		}
		expect(m.eventsOfType('slot-backstop-released')).toHaveLength(1)
		// the safety argument: the victim's log entries keep their slot field and stay
		// visible by inclusion below the held pin; the new tenant's sequences postdate it
		expect(m.renderValue(a, held)).toBe(5)
		// and the new tenant's own world folds the recycled slot's history in seq order
		const lastLive = m.idToBatch.get(live[live.length - 1]!)!
		const q = openRender(m, 'A', [lastLive])
		expect(m.renderValue(a, q)).toBe(126) // 5 retired +1s → 5, then the last set(126)
		m.renderEnd(q.id, 'discard')
		m.renderResume(held.id)
		m.renderEnd(held.id, 'discard')
		for (const id of live) m.retire(id)
		selfCheck(m)
	})
})
