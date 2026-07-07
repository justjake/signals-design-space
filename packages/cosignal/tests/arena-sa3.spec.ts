/**
 * NF2 P2.S-A pins, part 3: cold-base visibility in the arena walk (the
 * pre-existing S-A bug documented at B2, 41fe7d6). §4.3 decay-by-eviction
 * drops an unconsumed mark on an unwatched shadow to COLD (MUTABLE kept,
 * VALID cleared, value column evicted) — and arenaCheckDirty's dirt arms
 * matched only MUTABLE|DIRTY / MUTABLE|PENDING, so a cold base was
 * INVISIBLE to a validation walk entered from above. Every suite that
 * creates atoms before readers is masked by node-id order: the armed
 * epilogue (arena-checker.ts) serves in ascending node id, so a bottom-first
 * cone self-heals base-up (serve of the cold base refolds it and
 * shallow-upgrades its subs). These pins create the TOP first (lowest
 * node id; fn closures resolve the later-declared handles), forcing the
 * top-first serve order that consults the walk while the base is cold.
 *
 * All bridges run with the S-A divergence check armed (arena-served ≡
 * memo-served after every public operation) — the unfixed walk fails
 * these pins with `S-A divergence: … arena-served <stale> ≠ memo-served
 * <fresh>` out of the boundary operation's epilogue.
 */
import { describe, expect, it } from 'vitest';
import { __ctxUse, SuspendedRead } from '../src/index.js';
import { __newBridgeForTest, type AnyNode, type CosignalBridge, type Reader, type Value } from '../src/concurrent.js';
import { armArenaCheck } from './arena-checker.js';

const tick = (): Promise<void> => new Promise<void>((res) => setTimeout(res, 0));

function bridge(): CosignalBridge {
	const b = __newBridgeForTest();
	b.registerBridge();
	armArenaCheck(b);
	return b;
}

/** Mount a live committed watcher on `node` via a clean commit. */
function mount(b: CosignalBridge, root: string, node: AnyNode, name: string) {
	const p = b.passStart(root, []);
	const w = b.mountWatcher(p.id, node, name);
	b.passEnd(p.id, 'commit');
	return w;
}

/** Write + retire in one committed batch (a committed-truth advance). */
function commitWrite(b: CosignalBridge, node: AnyNode, value: unknown): void {
	const t = b.openBatch();
	b.write(t.id, node as never, 0, value);
	b.retire(t.id);
}

/** The shim-wrapper analog (`makeComputedNode`): a background suspension
 * folds to the thenable's stable sentinel VALUE instead of unwinding. */
function suspending(b: CosignalBridge, name: string, fn: (read: Reader, untracked: Reader) => Value): AnyNode {
	return b.computed(name, (read, untracked) => {
		try {
			return fn(read, untracked);
		} catch (err) {
			if (err instanceof SuspendedRead) return err;
			throw err;
		}
	});
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('S-A cold-base visibility in the walk (§4.2/§4.3; B2 41fe7d6 bug note)', () => {
	it('ATOM cold base: top-first-created cone (lowest id serves first) refolds through a decay-evicted atom instead of stale-serving', () => {
		const b = bridge();
		// TOP FIRST — lowest node id; the fn closures resolve the handles
		// declared below (bodies only run at evaluation time).
		let mid!: AnyNode;
		let base!: AnyNode;
		const top = b.computed('top', (read) => read(mid));
		mid = b.computed('mid', (read) => read(base));
		base = b.atom('base', 2);
		const w = mount(b, 'R', top, 'W');
		expect(w.lastRenderedValue).toBe(2); // cone folded + validated at the mount commit
		w.live = false; // unmount the only consumer (mid-episode: arena persists)
		// Committed write: the retirement fanout marks base DIRTY and the cone
		// PENDING; no live consumer refolds; §4.3 boundary decay then evicts
		// base to COLD (MUTABLE kept, VALID cleared, value column dropped).
		// The armed epilogue serves in node-id order — TOP first: its
		// arenaCheckDirty walk must treat the cold base as dirt, or it clears the
		// cone's PENDING and stale-serves 2 while the memo path serves 3.
		commitWrite(b, base, 3);
		expect(b.committedValue(top, 'R')).toBe(3);
		expect(b.committedValue(mid, 'R')).toBe(3);
	});

	it('COMPUTED cold base: a settlement-marked suspended leaf decays cold under an unwatched cone — the top-first walk must refold through it', async () => {
		const b = bridge();
		// TOP FIRST again; the suspending leaf and the atom get the highest ids.
		let mid!: AnyNode;
		let leaf!: AnyNode;
		let k!: AnyNode;
		const top = b.computed('top', (read) => `${String(read(mid))}:${String(read(k))}`);
		mid = b.computed('mid', (read) => {
			const v = read(leaf);
			return v instanceof SuspendedRead ? 'p' : v; // DERIVED from the sentinel (mid itself never box-suspends)
		});
		const gate = deferred<string>();
		const holder = { _useCache: undefined };
		leaf = suspending(b, 'leaf', () => __ctxUse(holder, 'x', () => gate.promise));
		k = b.atom('k', 0);
		const w = mount(b, 'R', top, 'W');
		expect(w.lastRenderedValue).toBe('p:0'); // leaf suspended; mid derives; cone cached
		w.live = false; // unwatch BEFORE the settlement: nothing will consume the marks
		// Open the boundary batch BEFORE the settle so the first armed epilogue
		// after the settlement is the retire itself (the boundary under test).
		const t = b.openBatch();
		b.write(t.id, k, 0, 1);
		// Background settlement at rest: the drain marks leaf's shadow DIRTY
		// (suspended-list scan), propagates PENDING up the unwatched cone, and
		// evicts leaf's memo — no live watcher consumes anything.
		gate.resolve('D');
		await tick();
		// The retire advances committed truth (cas + k's fingerprint move, so
		// the memo side re-derives 'D:1'), fans k DIRTY, and §4.3 decay drops
		// BOTH unconsumed marks — the leaf COMPUTED and the k atom — to cold.
		// The epilogue then serves TOP first: its walk descends mid (PENDING),
		// must see the cold leaf as dirt (and the cold atom k after it), or it
		// unwinds clearing PENDING and stale-serves 'p:0'.
		b.retire(t.id);
		expect(b.committedValue(top, 'R')).toBe('D:1');
		expect(b.committedValue(mid, 'R')).toBe('D');
	});
});
