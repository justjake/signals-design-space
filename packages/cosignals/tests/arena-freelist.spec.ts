/**
 * World-arena counterpart of the kernel link free-list discipline (dalien-signals port
 * study row 2, second instance): concurrent.ts world arenas must thread
 * `a.linkFree` through a genuinely spare link field (VERSION — freed links
 * never serve a version), never through NEXT_DEP, because arenaCheckDirty
 * reads NEXT_DEP off links that a mid-walk purge (arenaPurgeDeps epilogues,
 * arenaUnlink's unwatched-computed cascade, resolveShadow's dead-tenancy purge) has
 * already freed — those stale pointers must keep naming former neighbors,
 * never the free list.
 *
 * Test 1 pins the field discipline directly (mutation-style: fails when the
 * free list threads through NEXT_DEP). Test 2 is the behavioral companion:
 * the mid-walk-free schedule runs end-to-end with the S-A divergence check
 * armed (arena-served ≡ memo-served after every public operation).
 */
import { describe, expect, it } from 'vitest';
import { engine, __TEST__resetEngine, type AnyInternals, type CosignalEngine } from '../src/CosignalEngine.js';
import { armArenaCheck } from './arena-checker.js';

function freshEngine(arm = false): CosignalEngine {
	// Finish the previous test's leftover episode so the reset's idle preconditions hold.
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	__TEST__resetEngine();
	const b = engine;
	if (arm) armArenaCheck(b);
	return b;
}

function mount(b: CosignalEngine, root: string, node: AnyInternals, name: string) {
	const p = b.renderStart(root, []);
	const w = b.mountWatcher(p.id, node, name);
	b.renderEnd(p.id, 'commit');
	return w;
}

/** Write + retire in one committed batch (a committed-truth advance). */
function commitWrite(b: CosignalEngine, node: AnyInternals, value: unknown): void {
	const t = b.openBatch();
	b.write(t.id, node as never, 0, value);
	b.retire(t.id);
}

describe('world-arena link free list threads through a spare field (row 2 twin)', () => {
	it('freed links keep NEXT_DEP naming former neighbors — never the free list', () => {
		// Checker deliberately DISARMED: the armed epilogue refolds every
		// dirty shadow, re-allocating the freed records this test inspects.
		const b = freshEngine(false);

		// Spare cone (torn down first so the free list is non-empty when the
		// cone under test is torn — a fresh arena's zero free head masks the
		// clobber exactly as it does in the kernel).
		const gate2 = b.atom('gate2', 0);
		const spareAtom = b.atom('spareAtom', 1);
		const spareC = b.computed('spareC', (read) => read(spareAtom));
		const parent2 = b.computed('parent2', (read) => ((read(gate2) as number) === 0 ? read(spareC) : 0));
		mount(b, 'R', parent2, 'W2');

		// Cone under test: parent reads gate then victimC (so victimC's link
		// is parent's deps TAIL: its true former nextDep is 0).
		const gate = b.atom('gate', 0);
		const s2 = b.atom('s2', 5);
		const victimC = b.computed('victimC', (read) => read(s2));
		const parent = b.computed('parent', (read) => ((read(gate) as number) === 0 ? read(victimC) : 0));
		mount(b, 'R', parent, 'W');

		// Capture live link record ids before any teardown.
		const lAsp = b.__TEST__arenaLinkId('R', spareAtom, spareC);
		const lVp = b.__TEST__arenaLinkId('R', victimC, parent);
		const lSv = b.__TEST__arenaLinkId('R', s2, victimC);
		expect(lAsp).not.toBe(0);
		expect(lVp).not.toBe(0);
		expect(lSv).not.toBe(0);

		// Tear the spare cone: parent2 drops spareC → arenaPurgeDeps frees
		// (spareC→parent2); the unwatched-computed cascade frees
		// (spareAtom→spareC). The free list is now non-empty.
		commitWrite(b, gate2, 1);
		// (spareAtom→spareC) was spareC's ONLY dep: former nextDep = 0. With
		// the free list threaded through NEXT_DEP this reads the link freed
		// just before it instead.
		expect(b.__TEST__arenaLinkNextDep('R', lAsp)).toBe(0);

		// Tear the cone under test against the now-populated free list.
		commitWrite(b, gate, 1);
		// (victimC→parent) was parent's deps tail: former nextDep = 0.
		// Pre-fix this reads the PRIMED free head — a walk holding this link
		// across a mid-walk free would continue INTO the free list.
		expect(b.__TEST__arenaLinkNextDep('R', lVp)).toBe(0);
		// (s2→victimC) was victimC's only dep: former nextDep = 0. Pre-fix it
		// reads the (victimC→parent) record — the free-list chain.
		expect(b.__TEST__arenaLinkNextDep('R', lSv)).toBe(0);

		// Recycling still works through the spare-field free list: re-link
		// the dropped cone (allocations pop the freed records) and advance.
		commitWrite(b, gate, 0);
		expect(b.committedValue(parent, 'R')).toBe(5);
		expect(b.__TEST__arenaLinkMode('R', victimC, parent)).toBe('strong');
		commitWrite(b, s2, 9);
		expect(b.committedValue(parent, 'R')).toBe(9);

		// Arm the divergence check for a final lockstep sweep over the
		// recycled records (validator + arena-served ≡ memo-served).
		armArenaCheck(b);
		commitWrite(b, s2, 11);
		expect(b.committedValue(parent, 'R')).toBe(11);
	});

	it('mid-walk dep drop under arenaCheckDirty (the #203-analog schedule) stays lockstep with the check armed', () => {
		// Armed throughout: every public op's epilogue serves every shadow
		// FROM THE ARENA (arenaCheckDirty walks included) and compares against
		// the memo-served value; the structural validator runs first.
		const b = freshEngine(true);
		const s = b.atom('s', 0);
		const s3 = b.atom('s3', 0);
		let phase2 = false;
		// m1 exists to be DROPPED mid-walk: c0's refold under arenaCheckDirty's
		// unwind stops reading it; arenaPurgeDeps frees (m1→c0) and the
		// unwatched cascade frees (s3→m1) while the walk holds cursors.
		const m1 = b.computed('m1', (read) => {
			read(s3);
			return 1;
		});
		const c0 = b.computed('c0', (read) => {
			read(s);
			if (!phase2) read(m1);
			return 7; // value-stable: memo and arena must agree in every phase
		});
		const c1 = b.computed('c1', (read) => read(c0));
		const top = b.computed('top', (read) => read(c1));
		const w = mount(b, 'R', top, 'W');
		expect(w.lastRenderedValue).toBe(7);

		// Prime the arena free list so a walk that enters it would have
		// somewhere to go (pre-fix layout): tear an unrelated cone first.
		const gateP = b.atom('gateP', 0);
		const pAtom = b.atom('pAtom', 1);
		const pC = b.computed('pC', (read) => read(pAtom));
		const pTop = b.computed('pTop', (read) => ((read(gateP) as number) === 0 ? read(pC) : 0));
		mount(b, 'R', pTop, 'WP');
		commitWrite(b, gateP, 1);

		// The schedule: flip the phase, then write s. The armed epilogue's
		// serve of `top` runs arenaCheckDirty over live cursors while c0's
		// refold (in the unwind) drops m1 — links freed mid-walk. Must not
		// crash, must not diverge, must not spuriously refold beyond the
		// cone (the armed check + validator police it at every boundary).
		phase2 = true;
		commitWrite(b, s, 1);
		expect(b.committedValue(top, 'R')).toBe(7);
		expect(w.lastRenderedValue).toBe(7);

		// And the torn records recycle cleanly into new structure.
		commitWrite(b, s3, 5);
		expect(b.committedValue(m1, 'R')).toBe(1);
		commitWrite(b, s, 2);
		expect(b.committedValue(top, 'R')).toBe(7);
	});
});
