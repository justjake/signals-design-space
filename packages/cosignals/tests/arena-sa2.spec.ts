/**
 * Arena-serving pins, part 2: mixed-mode strong/weak link modes,
 * the wide lock-in walk under the no-fingerprint rule (marked shadows
 * refold unconditionally), root-churn retention + rematerialization,
 * grown-then-shrunk
 * mark decay, GEN id-tenancy, and mid-op arena growth
 * (tiny initial arena). Every engine reset runs with the divergence
 * check armed (arena-served ≡ reference folds after every public operation).
 */
import { describe, expect, it } from 'vitest'
import {
	engine,
	__TEST__resetEngine,
	type AnyInternals,
	type CosignalEngine,
	type EngineResetOptions,
} from '../src/CosignalEngine.js'
import { armArenaCheck } from './arena-checker.js'

function freshEngine(options?: EngineResetOptions): CosignalEngine {
	// Finish the previous test's leftover episode so the reset's idle preconditions hold.
	engine.discardAllWip()
	for (const t of engine.liveBatches()) {
		if (t.parked) {
			engine.settleAction(t.id)
		} else {
			engine.retire(t.id)
		}
	}
	__TEST__resetEngine(options)
	const b = engine
	armArenaCheck(b)
	return b
}

function mount(b: CosignalEngine, root: string, node: AnyInternals, name: string) {
	const p = b.renderStart(root, [])
	const w = b.mountWatcher(p.id, node, name)
	b.renderEnd(p.id, 'commit')
	return w
}

/** Write + retire in one committed batch (a committed-truth advance). */
function commitWrite(b: CosignalEngine, node: AnyInternals, value: unknown): void {
	const t = b.openBatch()
	b.write(t.id, node as never, 0, value)
	b.retire(t.id)
}

describe('S-A mixed-mode link modes (§4.4.1)', () => {
	it('four-phase transitions: first occurrence resets the mode; strong dominates duplicates; reuse is total', () => {
		const b = freshEngine()
		const mode = b.atom('mode', 0)
		const a = b.atom('a', 1)
		const c = b.computed('c', (read, untracked) => {
			const m = read(mode) as number
			if (m === 0) {
				return read(a)
			}
			if (m === 1) {
				return untracked(a)
			}
			if (m === 2) {
				const v = read(a)
				untracked(a) // duplicate occurrence may not downgrade
				return v
			}
			untracked(a)
			return read(a) // later occurrence upgrades weak→strong
		})
		mount(b, 'A', c, 'W')
		expect(b.__TEST__arenaLinkMode('A', a, c)).toBe('strong') // phase 0: tracked
		commitWrite(b, mode, 1)
		expect(b.__TEST__arenaLinkMode('A', a, c)).toBe('weak') // reused link RESET weak
		commitWrite(b, mode, 2)
		expect(b.__TEST__arenaLinkMode('A', a, c)).toBe('strong') // tracked-then-untracked: no downgrade
		commitWrite(b, mode, 3)
		expect(b.__TEST__arenaLinkMode('A', a, c)).toBe('strong') // untracked-then-tracked: upgrade
		commitWrite(b, mode, 1)
		expect(b.__TEST__arenaLinkMode('A', a, c)).toBe('weak') // and back: reset is total on reuse
	})

	it('weak coverage: an untracked-only dep still validates and drains (read-before-pending shape, fable B1)', () => {
		const b = freshEngine()
		const a = b.atom('a', 1)
		const c = b.computed('c', (_read, untracked) => untracked(a))
		const w = mount(b, 'A', c, 'W') // committed-quiet: weak a→c recorded unconditionally
		expect(b.__TEST__arenaLinkMode('A', a, c)).toBe('weak')
		commitWrite(b, a, 5) // site-(a) fanout marks a; weak propagation reaches c; drain corrects
		expect(w.lastRenderedValue).toBe(5)
		expect(b.committedValue(c, 'A')).toBe(5)
	})
})

describe('S-A fp-100/seq-50 lock-in walk (§4.2 no-fp rule)', () => {
	it('a below-max membership flip refolds by mark, never by fingerprint motion', () => {
		const b = freshEngine()
		const a = b.atom('a', 0)
		const c = b.computed('c', (read) => read(a))
		const w = mount(b, 'R', c, 'W')
		const tLow = b.openBatch() // T: the EARLIER sequence (the seq-50 analog)
		b.write(tLow.id, a, 1, (p: unknown) => (p as number) + 50)
		const tHigh = b.openBatch() // U: the later, retired sequence (the seq-100 analog)
		b.write(tHigh.id, a, 1, (p: unknown) => (p as number) + 100)
		b.retire(tHigh.id)
		expect(w.lastRenderedValue).toBe(100) // committed sees only the retired +100
		// Lock T in via a per-root commit: membership exposes T's log entry
		// BELOW the visible maximum — an fp gate could never see this flip;
		// the site-(b) mark + unconditional refold does (and the armed
		// divergence check proves arena ≡ memo at the epilogue).
		const p = b.renderStart('R', [tLow.id])
		b.renderWatcher(p.id, w.id)
		b.renderEnd(p.id, 'commit')
		expect(b.committedValue(c, 'R')).toBe(150) // (0 + 50) + 100 — the fold now includes seq-50
		expect(w.lastRenderedValue).toBe(150)
		b.retire(tLow.id)
	})
})

describe('S-A reclamation + rematerialization (§4.5.8)', () => {
	it('root churn: zero consumers at quiesce releases the arena to the pool; touching state later refolds cold', () => {
		const b = freshEngine()
		const a = b.atom('a', 1)
		const c = b.computed('c', (read) => read(a))
		const w = mount(b, 'R', c, 'W')
		expect(b.__TEST__arenaStats().committed).toBe(1)
		commitWrite(b, a, 2)
		w.live = false // unmount every consumer (mid-episode: NOT reclaimed yet)
		expect(b.__TEST__arenaStats().committed).toBe(1)
		b.quiesce()
		const stats = b.__TEST__arenaStats()
		expect(stats.committed).toBe(0) // released at the quiesce sweep…
		expect(stats.pooled).toBeGreaterThanOrEqual(1) // …buffer returned to the pool
		expect(b.committedValue(c, 'R')).toBe(2) // a later read refolds (no arena required)
	})

	it('rematerialization: a remounted consumer repopulates the cone before any post-commit write needs routing', () => {
		const b = freshEngine()
		const a = b.atom('a', 1)
		const c = b.computed('c', (read) => read(a))
		const w1 = mount(b, 'R', c, 'W1')
		w1.live = false
		b.quiesce()
		expect(b.__TEST__arenaStats().committed).toBe(0)
		const w2 = mount(b, 'R', c, 'W2') // remount: the commit populator loop rebuilds links at this commit
		expect(b.__TEST__arenaStats().committed).toBe(1)
		expect(b.__TEST__arenaLinkMode('R', a, c)).toBe('strong')
		commitWrite(b, a, 9) // handler write AFTER the rebuild: delivery + drain route
		expect(w2.lastRenderedValue).toBe(9)
	})
})

describe('S-A mark decay (§4.3) + growth (§4.5.9) + GEN tenancy (§4.5.3)', () => {
	it('grown-then-shrunk: a write-storm against an unwatched cone decays to cold instead of re-appending forever; remount refolds fresh', () => {
		const b = freshEngine()
		const a = b.atom('a', 0)
		const c = b.computed('c', (read) => read(a))
		const w = mount(b, 'R', c, 'W')
		commitWrite(b, a, 1)
		w.live = false // the cone is now unwatched (arena persists until quiesce)
		for (let i = 2; i <= 8; i++) {
			commitWrite(b, a, i)
		} // write-storm
		// Each boundary's decay dropped the unconsumed marks to cold: the
		// dirty lists stay CONE-bounded instead of growing with the storm.
		// (Since S-B the armed epilogue's own serves consume the final
		// boundary's marks, and consumed entries stay listed until the NEXT
		// decay — drain seeding stands on that persistence — so the bound is
		// the cone size, never the storm length.)
		expect(b.__TEST__arenaStats().dirty).toBeLessThanOrEqual(2)
		const w2 = mount(b, 'R', c, 'W2') // remount ⇒ cold refold serves fresh values
		expect(b.__TEST__arenaStats().dirty).toBe(0) // the commit's decay dropped the consumed leftovers
		expect(w2.lastRenderedValue).toBe(8)
	})

	it('stride-sized initial arena: every growth path exercises mid-walk (structural validator green throughout)', () => {
		const b = freshEngine({ arenaInitInts: 16 }) // 2 records: every shadow/link allocation past the first outruns the reservation — real mid-operation doubling on every path
		const atoms = Array.from({ length: 12 }, (_, i) => b.atom(`a${i}`, i))
		const c = b.computed('sum', (read) => atoms.reduce((s, n) => s + (read(n) as number), 0))
		const w = mount(b, 'R', c, 'W')
		expect(w.lastRenderedValue).toBe(66)
		const shell = b.__TEST__arena('R')!
		expect(shell.memory.length).toBeGreaterThan(16) // the buffers really doubled (grow-by-copy; ids stable, the armed check revalidates values)
		expect(shell.clocks.length).toBe(shell.memory.length >> 3) // the clock column grew WITH the record store (one slot per record)
		commitWrite(b, atoms[3], 100) // fanout + refold across the grown arena
		expect(b.committedValue(c, 'R')).toBe(163)
	})

	it('GEN id-tenancy: a bumped generation makes the shadow re-tenant cold — never serving the dead tenancy', () => {
		const b = freshEngine()
		const a = b.atom('a', 1)
		const c = b.computed('c', (read) => read(a))
		mount(b, 'R', c, 'W')
		expect(b.committedValue(c, 'R')).toBe(1)
		b.__TEST__bumpNodeGen(c.id) // the S-C free-list reuse analog, forced
		// The next consult validates the stamp, purges the dead tenancy's
		// links, and refolds under the new tenant (the armed divergence
		// check + validator run at the next epilogue).
		commitWrite(b, a, 7)
		expect(b.committedValue(c, 'R')).toBe(7)
		expect(b.__TEST__arenaLinkMode('R', a, c)).toBe('strong') // re-tracked under the new GEN
	})
})
