/**
 * NF2 P2.S-A pins, part 2 (§4.9.3): mixed-mode strong/weak link modes
 * (§4.4.1), the fp-100/seq-50 lock-in walk under the no-fp rule (§4.2),
 * root-churn retention + rematerialization (§4.5.8), grown-then-shrunk
 * mark decay (§4.3), GEN id-tenancy (§4.5.3), and mid-op arena growth
 * (§4.5.9 — tiny initial arena). All bridges run with the S-A divergence
 * check armed (arena-served ≡ memo-served after every public operation).
 */
import { describe, expect, it } from 'vitest';
import { __newBridgeForTest, type AnyNode, type BridgeOptions, type CosignalBridge } from '../src/concurrent.js';
import { armArenaCheck } from './arena-checker.js';

function bridge(options?: BridgeOptions): CosignalBridge {
	const b = __newBridgeForTest(options);
	b.registerBridge();
	armArenaCheck(b);
	return b;
}

function mount(b: CosignalBridge, root: string, node: AnyNode, name: string) {
	const p = b.passStart(root, []);
	const w = b.mountWatcher(p.id, node, name);
	b.passEnd(p.id, 'commit');
	return w;
}

/** Write + retire in one committed batch (a committed-truth advance). */
function commitWrite(b: CosignalBridge, node: AnyNode, value: unknown): void {
	const t = b.openBatch();
	b.write(t.id, node as never, { kind: 'set', value });
	b.retire(t.id, true);
}

describe('S-A mixed-mode link modes (§4.4.1)', () => {
	it('four-phase transitions: first occurrence resets the mode; strong dominates duplicates; reuse is total', () => {
		const b = bridge();
		const mode = b.atom('mode', 0);
		const a = b.atom('a', 1);
		const c = b.computed('c', (read, untracked) => {
			const m = read(mode) as number;
			if (m === 0) return read(a);
			if (m === 1) return untracked(a);
			if (m === 2) {
				const v = read(a);
				untracked(a); // duplicate occurrence may not downgrade
				return v;
			}
			untracked(a);
			return read(a); // later occurrence upgrades weak→strong
		});
		mount(b, 'A', c, 'W');
		expect(b.__arenaLinkMode('A', a, c)).toBe('strong'); // phase 0: tracked
		commitWrite(b, mode, 1);
		expect(b.__arenaLinkMode('A', a, c)).toBe('weak'); // reused link RESET weak
		commitWrite(b, mode, 2);
		expect(b.__arenaLinkMode('A', a, c)).toBe('strong'); // tracked-then-untracked: no downgrade
		commitWrite(b, mode, 3);
		expect(b.__arenaLinkMode('A', a, c)).toBe('strong'); // untracked-then-tracked: upgrade
		commitWrite(b, mode, 1);
		expect(b.__arenaLinkMode('A', a, c)).toBe('weak'); // and back: reset is total on reuse
	});

	it('weak coverage: an untracked-only dep still validates and drains (read-before-pending shape, fable B1)', () => {
		const b = bridge();
		const a = b.atom('a', 1);
		const c = b.computed('c', (_read, untracked) => untracked(a));
		const w = mount(b, 'A', c, 'W'); // committed-quiet: weak a→c recorded unconditionally
		expect(b.__arenaLinkMode('A', a, c)).toBe('weak');
		commitWrite(b, a, 5); // site-(a) fanout marks a; weak propagation reaches c; drain corrects
		expect(w.lastRenderedValue).toBe(5);
		expect(b.committedValue(c, 'A')).toBe(5);
	});
});

describe('S-A fp-100/seq-50 lock-in walk (§4.2 no-fp rule)', () => {
	it('a below-max membership flip refolds by mark, never by fingerprint motion', () => {
		const b = bridge();
		const a = b.atom('a', 0);
		const c = b.computed('c', (read) => read(a));
		const w = mount(b, 'R', c, 'W');
		const tLow = b.openBatch(); // T: the EARLIER sequence (the seq-50 analog)
		b.write(tLow.id, a, { kind: 'update', fn: (p) => (p as number) + 50 });
		const tHigh = b.openBatch(); // U: the later, retired sequence (the seq-100 analog)
		b.write(tHigh.id, a, { kind: 'update', fn: (p) => (p as number) + 100 });
		b.retire(tHigh.id, true);
		expect(w.lastRenderedValue).toBe(100); // committed sees only the retired +100
		// Lock T in via a per-root commit: membership exposes T's receipt
		// BELOW the visible maximum — an fp gate could never see this flip;
		// the site-(b) mark + unconditional refold does (and the armed
		// divergence check proves arena ≡ memo at the epilogue).
		const p = b.passStart('R', [tLow.id]);
		b.renderWatcher(p.id, w.id);
		b.passEnd(p.id, 'commit');
		expect(b.committedValue(c, 'R')).toBe(150); // (0 + 50) + 100 — the fold now includes seq-50
		expect(w.lastRenderedValue).toBe(150);
		b.retire(tLow.id, true);
	});
});

describe('S-A reclamation + rematerialization (§4.5.8)', () => {
	it('root churn: zero consumers at quiesce releases the arena to the pool; touching state later refolds cold', () => {
		const b = bridge();
		const a = b.atom('a', 1);
		const c = b.computed('c', (read) => read(a));
		const w = mount(b, 'R', c, 'W');
		expect(b.__arenaStats().committed).toBe(1);
		commitWrite(b, a, 2);
		w.live = false; // unmount every consumer (mid-episode: NOT reclaimed yet)
		expect(b.__arenaStats().committed).toBe(1);
		b.quiesce();
		const stats = b.__arenaStats();
		expect(stats.committed).toBe(0); // released at the quiesce sweep…
		expect(stats.pooled).toBeGreaterThanOrEqual(1); // …buffer returned to the pool
		expect(b.committedValue(c, 'R')).toBe(2); // a later read refolds (no arena required)
	});

	it('rematerialization: a remounted consumer repopulates the cone before any post-commit write needs routing', () => {
		const b = bridge();
		const a = b.atom('a', 1);
		const c = b.computed('c', (read) => read(a));
		const w1 = mount(b, 'R', c, 'W1');
		w1.live = false;
		b.quiesce();
		expect(b.__arenaStats().committed).toBe(0);
		const w2 = mount(b, 'R', c, 'W2'); // remount: the §4.4.2 populators rebuild links at THIS commit
		expect(b.__arenaStats().committed).toBe(1);
		expect(b.__arenaLinkMode('R', a, c)).toBe('strong');
		commitWrite(b, a, 9); // handler write AFTER the rebuild: delivery + drain route
		expect(w2.lastRenderedValue).toBe(9);
	});
});

describe('S-A mark decay (§4.3) + growth (§4.5.9) + GEN tenancy (§4.5.3)', () => {
	it('grown-then-shrunk: a write-storm against an unwatched cone decays to cold instead of re-appending forever; remount refolds fresh', () => {
		const b = bridge();
		const a = b.atom('a', 0);
		const c = b.computed('c', (read) => read(a));
		const w = mount(b, 'R', c, 'W');
		commitWrite(b, a, 1);
		w.live = false; // the cone is now unwatched (arena persists until quiesce)
		for (let i = 2; i <= 8; i++) commitWrite(b, a, i); // write-storm
		// Each boundary's decay dropped the unconsumed marks to cold: the
		// dirty lists stay CONE-bounded instead of growing with the storm.
		// (Since S-B the armed epilogue's own serves consume the final
		// boundary's marks, and consumed entries stay listed until the NEXT
		// decay — drain seeding stands on that persistence — so the bound is
		// the cone size, never the storm length.)
		expect(b.__arenaStats().dirty).toBeLessThanOrEqual(2);
		const w2 = mount(b, 'R', c, 'W2'); // remount ⇒ cold refold serves fresh values
		expect(b.__arenaStats().dirty).toBe(0); // the commit's decay dropped the consumed leftovers
		expect(w2.lastRenderedValue).toBe(8);
	});

	it('stride-sized initial arena: every growth path exercises mid-walk (structural validator green throughout)', () => {
		const b = bridge({ arenaInitInts: 16 }); // two records: every later alloc grows mid-operation
		const atoms = Array.from({ length: 12 }, (_, i) => b.atom(`a${i}`, i));
		const c = b.computed('sum', (read) => atoms.reduce((s, n) => s + (read(n) as number), 0));
		const w = mount(b, 'R', c, 'W');
		expect(w.lastRenderedValue).toBe(66);
		commitWrite(b, atoms[3]!, 100); // fanout + refold across the grown arena
		expect(b.committedValue(c, 'R')).toBe(163);
	});

	it('GEN id-tenancy: a bumped generation makes the shadow re-tenant cold — never serving the dead tenancy', () => {
		const b = bridge();
		const a = b.atom('a', 1);
		const c = b.computed('c', (read) => read(a));
		mount(b, 'R', c, 'W');
		expect(b.committedValue(c, 'R')).toBe(1);
		b.__bumpNodeGenForTest(c.id); // the S-C free-list reuse analog, forced
		// The next consult validates the stamp, purges the dead tenancy's
		// links, and refolds under the new tenant (the armed divergence
		// check + validator run at the next epilogue).
		commitWrite(b, a, 7);
		expect(b.committedValue(c, 'R')).toBe(7);
		expect(b.__arenaLinkMode('R', a, c)).toBe('strong'); // re-tracked under the new GEN
	});
});
