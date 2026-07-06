/**
 * NF2 P2.S-D pins (§4.8 S-D: arena pooling hardened + wrap tests) — the
 * S-C remainder. Pinned here:
 *
 *  1. Pool shell reuse round-trip: release SCRUBS totally (columns zeroed,
 *     written prefix zeroed, lists dropped) while CAPACITY persists (the B1
 *     cold-pass shave); claimGen is monotone with claim/release parity
 *     (odd = live tenancy, even = at rest); a re-claimed shell serves
 *     current truth, never dead-tenancy residue.
 *  2. The pool cap (8): releases beyond the cap drop the shell.
 *  3. Growth across pooled tenancies: a buffer grown in tenancy 1 re-claims
 *     at its grown capacity and keeps growing mid-op in tenancy 2.
 *  4. Suspended bookkeeping at release: the global suspended count returns
 *     to zero with the arena, and a settlement arriving AFTER the release
 *     is a no-op, not a crash.
 *  5. Int32 clock-wrap renumbers (the S-D hardening): readClock stamps
 *     into AF.MARK and cycle stamps into L_VER — Int32Array fields that
 *     would truncate past 2^31-1. The bump helpers renumber at
 *     A_CLOCK_LIMIT (0x7fff0000, mirrored below): stamps reset to 0
 *     (= stale, the conservative fail-open direction), clocks restart, and
 *     values stay EXACT across the boundary (armed divergence check).
 *     Same-eval link dedup keeps deps chains duplicate-free through the
 *     renumber (single-level frames renumber only at frame START, so all
 *     stamps within a frame are post-renumber-consistent; the nested-frame
 *     fail-open argument lives at aRenumberLinkVersions' doc).
 *
 * Every bridge runs with the S-A divergence check ARMED: arena-served ≡
 * fold-truth after every public operation, plus the structural validator.
 */
import { describe, expect, it } from 'vitest';
import { __ctxUse, SuspendedRead } from '../src/index.js';
import { __newBridgeForTest, type AnyNode, type BridgeOptions, type CosignalBridge } from '../src/concurrent.js';

/** Mirror of concurrent.ts's private A_CLOCK_LIMIT (0x7fff0000): stores of
 * the limit itself still fit Int32 (65535 under 2^31-1); the renumber fires
 * on the bump that would pass it. */
const A_CLOCK_LIMIT = 0x7fff0000;

const tick = (): Promise<void> => new Promise<void>((res) => setTimeout(res, 0));

function bridge(options?: BridgeOptions): CosignalBridge {
	const b = __newBridgeForTest(options);
	b.registerBridge();
	b.__setArenaCheck(true);
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** The shim-wrapper analog: a background suspension folds to the thenable's
 * stable sentinel VALUE instead of unwinding (battery 16d's rule). */
function suspendingUse(b: CosignalBridge, name: string, holder: { _useCache: unknown }, thenable: () => PromiseLike<unknown>): AnyNode {
	return b.computed(name, () => {
		try {
			return __ctxUse(holder as never, 'k', thenable);
		} catch (err) {
			if (err instanceof SuspendedRead) return err;
			throw err;
		}
	});
}

/** Length of a sub's deps chain counted from its FIRST dep's link (the fn
 * must read that dep first, making its link the chain head). A same-eval
 * dedup miss would mint a duplicate link and lengthen the chain. */
function depsChainLen(b: CosignalBridge, root: string, firstDep: AnyNode, sub: AnyNode): number {
	let cur = b.__arenaLinkIdForTest(root, firstDep, sub);
	let n = 0;
	while (cur !== 0) {
		n++;
		cur = b.__arenaLinkNextDepForTest(root, cur);
	}
	return n;
}

describe('S-D pool shell reuse (§4.8)', () => {
	it('release scrubs totally, keeps capacity, bumps claimGen to at-rest parity; re-claim serves current truth', () => {
		const b = bridge();
		const a0 = b.atom('a', 1);
		const c = b.computed('c', (read) => read(a0));
		const w = mount(b, 'R', c, 'W');
		const shell = b.__arenaForTest('R')!;
		expect(shell.alive).toBe(true);
		expect(shell.claimGen % 2).toBe(1); // live tenancy = odd (claimed once more than released)
		commitWrite(b, a0, 2);
		expect(w.lastRenderedValue).toBe(2);
		const genLive = shell.claimGen;
		const buf = shell.W;
		const valsCap = shell.vals.length;
		expect(valsCap).toBeGreaterThan(0);
		w.live = false;
		b.quiesce(); // zero consumers: the sweep releases the arena to the pool
		expect(b.__arenaPoolForTest()).toContain(shell);
		expect(shell.alive).toBe(false);
		expect(shell.claimGen).toBe(genLive + 1); // release bump: even = at rest
		expect(shell.W).toBe(buf); // the buffer rides the pooled shell
		// The scrub is TOTAL — dead-tenancy residue cannot validate…
		expect(shell.W.every((x) => x === 0)).toBe(true); // written prefix zeroed; past it was fresh-zero
		expect(shell.vals.every((v) => v === undefined)).toBe(true); // value refs released (no pooled leak)
		expect(shell.byNode.every((x) => x === 0)).toBe(true);
		expect(shell.suspIdx.every((x) => x === 0)).toBe(true);
		expect(shell.walk.every((x) => x === 0)).toBe(true);
		expect(shell.weakSubs.every((x) => x === 0)).toBe(true);
		expect(shell.weakSubsTail.every((x) => x === 0)).toBe(true);
		expect(shell.dirty.length).toBe(0);
		expect(shell.suspended.length).toBe(0);
		expect(shell.linkFree).toBe(0);
		expect(shell.readClock).toBe(0);
		expect(shell.cycle).toBe(0);
		// …while CAPACITY persists (the B1 shave: no re-push storm next tenancy).
		expect(shell.vals.length).toBe(valsCap);
		// Advance committed truth while nothing is materialized, then remount
		// under a DIFFERENT root: the claimed shell (this one or the mount
		// pass's recycled shell — pass arenas share the pool) must refold
		// fresh truth, never tenancy-1 residue.
		commitWrite(b, a0, 3);
		const w2 = mount(b, 'S', c, 'W2');
		expect(w2.lastRenderedValue).toBe(3);
		expect(b.committedValue(c, 'S')).toBe(3);
		expect(shell.claimGen).toBeGreaterThan(genLive + 1); // the shell WAS re-claimed (pass or committed tenancy)
		const s = b.__arenaForTest('S')!;
		expect(s.claimGen % 2).toBe(1); // live parity again
		expect(s.root).toBe('S');
	});

	it('pool cap: releases beyond 8 drop the shell instead of pooling it', () => {
		const b = bridge();
		const a0 = b.atom('a', 1);
		const watchers = [];
		for (let i = 0; i < 10; i++) {
			const c = b.computed(`c${i}`, (read) => read(a0));
			watchers.push(mount(b, `R${i}`, c, `W${i}`));
		}
		expect(b.__arenaStats().committed).toBe(10);
		for (const w of watchers) w.live = false;
		b.quiesce(); // ≥10 releases land on a pool that caps at 8
		const stats = b.__arenaStats();
		expect(stats.committed).toBe(0);
		expect(stats.pooled).toBe(8);
	});

	it('growth across pooled tenancies: a grown buffer re-claims at capacity and keeps growing mid-op', () => {
		const b = bridge({ arenaInitInts: 16 }); // two records: every alloc beyond the burn grows mid-operation
		const atoms = Array.from({ length: 12 }, (_, i) => b.atom(`a${i}`, i));
		const sum = b.computed('sum', (read) => atoms.reduce((s, n) => s + (read(n) as number), 0));
		const w1 = mount(b, 'R', sum, 'W1');
		expect(w1.lastRenderedValue).toBe(66);
		const shell = b.__arenaForTest('R')!;
		const grownLen = shell.W.length;
		expect(grownLen).toBeGreaterThan(16); // tenancy 1 grew the buffer
		w1.live = false;
		b.quiesce();
		expect(shell.W.length).toBe(grownLen); // pooled at grown capacity
		// Tenancy 2 under another root: a WIDER cone — whatever pooled shell
		// serves it starts at pooled capacity and grows further, with the
		// fresh-record invariant enforced by the armed check + validator.
		const more = Array.from({ length: 24 }, (_, i) => b.atom(`b${i}`, i));
		const sum2 = b.computed('sum2', (read) => more.reduce((s, n) => s + (read(n) as number), 0));
		const w2 = mount(b, 'S', sum2, 'W2');
		expect(w2.lastRenderedValue).toBe(276);
		commitWrite(b, more[7]!, 1007); // fanout + refold across the re-grown arena
		expect(b.committedValue(sum2, 'S')).toBe(276 - 7 + 1007);
	});

	it('suspended bookkeeping: release returns the global count to zero; a post-release settlement is a no-op', async () => {
		const b = bridge();
		const gate = deferred<string>();
		const holder = { _useCache: undefined };
		const c = suspendingUse(b, 'c', holder, () => gate.promise);
		const w = mount(b, 'R', c, 'W');
		expect(w.lastRenderedValue).toBeInstanceOf(SuspendedRead);
		expect(b.__arenaStats().suspended).toBe(1);
		w.live = false;
		b.quiesce(); // releaseArena must give back the suspended count with the list
		expect(b.__arenaStats().suspended).toBe(0);
		expect(b.__arenaStats().committed).toBe(0);
		gate.resolve('DATA'); // settles into a world with NO arena: tap must no-op cleanly
		await tick();
		expect(b.__arenaStats().suspended).toBe(0);
		expect(b.committedValue(c, 'R')).toBe('DATA'); // fresh fold sees settled truth
	});
});

describe('S-D stale-loading wart verification (the pre-S-B note)', () => {
	// The wart, as noted pre-S-B: "a ctx.use sentinel cached in a committed
	// MEMO is refreshed only by committed-truth motion" — settlement mints no
	// receipt, so an unwatched suspension could serve stale loading to a
	// re-watcher until some unrelated write moved committed truth. The memo
	// arms are DELETED (S-C) and the settlement tap re-marks arenas directly
	// (S-A §4.5.4), so the wart should have died with the memos. These pins
	// are the regression: re-watch BEFORE any other state motion sees DATA.
	it('unwatched suspending derived + settle + re-watch before any state motion → data, never stale loading', async () => {
		const b = bridge();
		const gate = deferred<string>();
		const holder = { _useCache: undefined };
		const c = suspendingUse(b, 'c', holder, () => gate.promise);
		const w1 = mount(b, 'R', c, 'W1');
		expect(w1.lastRenderedValue).toBeInstanceOf(SuspendedRead); // sentinel cached while watched
		expect(b.__arenaStats().suspended).toBe(1);
		w1.live = false; // UNWATCHED while still suspended (no quiesce: the arena persists)
		gate.resolve('DATA'); // settles with zero live consumers anywhere
		await tick();
		// The tap re-marked the persisting arena's shadow even with no watcher
		// to correct; nothing CONSUMES an unwatched cone, so the box legally
		// persists (marks ARE the invalidation — evict-don't-serve laziness).
		expect(b.__arenaStats().suspended).toBe(1);
		// RE-WATCH with no other state motion in between: the mount's own
		// evaluation must refold to the settled value — the memo-era wart
		// would have served the cached sentinel here until a real write.
		const w2 = mount(b, 'R', c, 'W2');
		expect(w2.lastRenderedValue).toBe('DATA');
		expect(b.committedValue(c, 'R')).toBe('DATA');
		expect(b.__arenaStats().suspended).toBe(0); // consumption unwound the box
	});

	it('never-watched variant: a committedValue-cached sentinel + settle + first watch → data', async () => {
		const b = bridge();
		const gate = deferred<string>();
		const holder = { _useCache: undefined };
		const c = suspendingUse(b, 'c', holder, () => gate.promise);
		// Cache the sentinel in the committed world WITHOUT ever mounting.
		expect(b.committedValue(c, 'R')).toBeInstanceOf(SuspendedRead);
		gate.resolve('DATA');
		await tick();
		const w = mount(b, 'R', c, 'W'); // first watcher ever, before any other motion
		expect(w.lastRenderedValue).toBe('DATA');
		expect(b.committedValue(c, 'R')).toBe('DATA');
	});
});

describe('S-D Int32 clock-wrap renumbers (§4.8 hardening)', () => {
	it('readClock at the ceiling: the renumber fires, marks reset, delivery stays exact across the boundary', () => {
		const b = bridge();
		const a0 = b.atom('a', 0);
		const gatee = b.atom('g', 100);
		const c = b.computed('c', (read) => (read(a0) as number) + (read(gatee) as number));
		const w = mount(b, 'R', c, 'W');
		const shell = b.__arenaForTest('R')!;
		shell.readClock = A_CLOCK_LIMIT - 3; // a hair under the ceiling
		for (let i = 1; i <= 6; i++) {
			commitWrite(b, a0, i); // each write: fan (stamps MARK = clock) + serves (bump the clock)
			expect(w.lastRenderedValue).toBe(100 + i); // exact through the renumber
		}
		expect(shell.readClock).toBeGreaterThan(0);
		expect(shell.readClock).toBeLessThan(1000); // the renumber restarted the clock
		// Every live MARK stamp is again a small post-renumber value (Int32-exact).
		for (let nid = 0; nid < shell.byNode.length; nid++) {
			const sh = shell.byNode[nid]!;
			if (sh !== 0) expect(shell.W[sh + 7]).toBeLessThanOrEqual(shell.readClock); // AF.MARK = 7
		}
	});

	it('cycle at the ceiling: link versions renumber; same-eval dedup keeps deps chains duplicate-free', () => {
		const b = bridge();
		const x = b.atom('x', 1);
		const y = b.atom('y', 10);
		const z = b.atom('z', 100);
		// x is read FIRST (its link heads the chain) and AGAIN nonadjacently —
		// the aLinkInsert tail probes carry the same-eval dedup that a wrapped
		// L_VER stamp would break.
		const c = b.computed('c', (read) => {
			const first = read(x) as number;
			const mid = read(y) as number;
			const again = read(x) as number;
			return first + mid + again + (read(z) as number);
		});
		const w = mount(b, 'R', c, 'W');
		expect(w.lastRenderedValue).toBe(112);
		expect(depsChainLen(b, 'R', x, c)).toBe(3); // x, y, z — the duplicate read reused, not re-minted
		const shell = b.__arenaForTest('R')!;
		shell.cycle = A_CLOCK_LIMIT - 2;
		for (let i = 2; i <= 6; i++) {
			commitWrite(b, x, i); // re-evals bump the cycle across the ceiling
			expect(w.lastRenderedValue).toBe(2 * i + 110);
			expect(depsChainLen(b, 'R', x, c)).toBe(3); // dedup exact through the renumber
		}
		expect(shell.cycle).toBeGreaterThan(0);
		expect(shell.cycle).toBeLessThan(1000); // the renumber restarted the cycle
	});
});
