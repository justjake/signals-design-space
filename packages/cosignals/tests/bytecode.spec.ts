/**
 * Bytecode budget regression test. V8 only inlines a function whose bytecode
 * is under --max-inlined-bytecode-size (460 in Node 24, 920 cumulative per
 * optimized function), and typed-array field access generates ~3x the
 * bytecode of an object field load — a hot function that drifts past 460
 * silently stops inlining and costs real time (the monolithic link() at 475
 * never inlined; splitting measured -8..-13% on propagation shapes;
 * checkDirty at 543 could not inline into run()/computedRead until split).
 *
 * cosignals ships TS source, so budgets are asserted against an
 * esbuild-bundled smoke (const enums inline to literals — the codegen
 * consumers execute), run under `node --print-bytecode`. Raising a budget is
 * a deliberate act: justify it in the PR. Budgets are V8-version-sensitive:
 * measured on Node 24 (CI pins it); the suite skips elsewhere.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const INLINE_LIMIT = 460;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

// name -> budget (bytecode bytes), all under the inline limit: current size
// (Node 24.16, esbuild 0.28 bundle) plus slack. Pins the propagate/read/
// flush hot paths of the kernel and the world-arena walks of the
// concurrency engine — including the freelist alloc/free pair.
const BUDGETS: Record<string, number> = {
	// graph kernel (src/Kernel.ts createKernel internals)
	link: 180, // 154: re-track fast path
	linkInsert: 380, // 346: out-of-line insertion tail (+ the per-link lifecycle retain)
	unlink: 350, // 308: carries the per-link lifecycle release (one dep FLAGS
	// load + machinery-owned gate — the kernel arm is a refcount so machinery
	// computeds' links can be excluded; see index.ts D1)
	propagate: 460, // 426: already close to the limit — watch it
	checkDirty: 440, // 426: entry wrapper + shallow/two-level fast paths +
	// chainCheck dispatch (was a 537-byte monolith); inside the inline limit
	// so run()/computedReadSlow can absorb it
	checkDirtyLoop: 460, // 411: the general walk, out of line — at the limit
	updateAndShallow: 100, // 40: update() + sibling Pending->Dirty upgrade
	chainCheck: 320, // 290: stackless chain walk (not inlined; it loops)
	shallowPropagate: 130, // 106
	isValidLink: 60, // 47
	update: 90, // 74
	updateComputed: 445, // 432: the durable-clock bump on changed outcomes
	// (both return arms test-and-stamp; the flattening's bump table) — still
	// under the inline limit
	updateSignal: 80, // 62
	notify: 210, // 178
	run: 390, // 333
	purgeDeps: 80, // 66
	unlinkChildEffects: 100, // 82
	allocLink: 120, // 102
	freeLink: 50, // 42: threads the free list through spare field 7 + the
	// generated clock-slot scrub (a reused link must not carry the old
	// tenant's lastValidatedAt stamp)
	// public read/write paths
	readAtom: 120, // 98
	write: 130, // 96
	computedRead: 110, // 84: hot/cold split entry
	computedReadSlow: 460, // 418: the out-of-line ladder — near the limit (never-evaluated probe reads MUTABLE; the ownership bit is carried)
	writeAtom: 90, // 67
	flush: 170, // 139
	// concurrency engine (src/concurrent.ts world arenas)
	arenaLink: 230, // 179
	arenaLinkInsert: 380, // 302
	arenaUnlink: 340, // 276
	arenaPropagate: 460, // 453: segregated-list interleave — each descended sub
	// contributes its weak head as a parked continuation (one shared grow
	// block; the cycle-cap thrower moved out of line) — at the inline limit,
	// exactly like checkDirtyLoop; watch it
	arenaShallowPropagate: 160, // 127
	arenaPurgeDeps: 170, // 137
	arenaAllocLink: 90, // 71
	arenaFreeLink: 50, // 37: threads a.linkFree through VERSION (the arena counterpart of the kernel freeLink)
	resolveShadow: 210, // 163
	foldAtom: 190, // 142
	arenaUpdateShadow: 230, // 173 (the readClock bump routed through arenaBumpReadClock)
	arenaBumpReadClock: 60, // 35: Int32 wrap guard on the consumption bump path
	arenaBumpCycle: 60, // 37: Int32 wrap guard on the evaluation-cycle bump
	arenaCheckDirty: 100, // 67: entry wrapper owning the arenaCheckSp restore
	// (was a 567-byte walk monolith)
	arenaCheckDirtyLoop: 450, // 407: the general arena walk, out of line
	arenaUpdateAndShallow: 110, // 74: refold + sibling Pending->Dirty upgrade
	arenaFoldOutcome: 385, // 367: fold-outcome classification, out of line —
	// includes the comparator arm (custom-equality computeds compare against
	// the arena-local previous, in head order; the user-fn call itself is out
	// of line in arenaIsValueEqualCold, so the hot default arm stays
	// closure-free) plus the committed-clock bump on changed outcomes (both
	// the suspension and value arms test-and-stamp) — under the inline limit
	arenaSyncObservationAfterRefold: 90, // 65: out-of-line observation epilogue (observed nodes only)
};

// Functions over the V8 inline budget, pinned at current size. A function
// that outgrows the inline limit gets pinned here (deliberately, justified
// in the PR); a pin that drops back under it moves into BUDGETS.
const OVER_LIMIT_PINS: Record<string, number> = {
	arenaUpdateComputed: 530, // 479: the refold wrapper carries the
	// observed-capture open (obsRefs probe) and the paired world-eval trace
	// hooks — over the 460 inline limit, deliberately: the wrapper brackets
	// a dynamic user-fn call, so inlining the wrapper is not load-bearing
	// (the walk arms — arenaCheckDirty/-Loop, arenaUpdateShadow,
	// arenaUpdateAndShallow — all stay inside the budget); the observation
	// sync epilogue is already out of line (arenaSyncObservationAfterRefold).
};

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smoke = path.join(pkgRoot, 'tests', 'fixtures', 'bytecodeSmoke.ts');
const esbuildBin = path.join(pkgRoot, 'node_modules', '.bin', 'esbuild');

function measure(): Map<string, number> {
	const outDir = mkdtempSync(path.join(tmpdir(), 'cosignals-bytecode-'));
	const bundle = path.join(outDir, 'bytecodeSmoke.mjs');
	execFileSync(
		esbuildBin,
		['--bundle', smoke, '--format=esm', '--platform=node', '--target=node24', `--outfile=${bundle}`, '--log-level=warning'],
		{ cwd: pkgRoot, encoding: 'utf8' },
	);
	// NOTE: --print-bytecode-filter takes ONE pattern, not a comma list (a
	// list silently matches nothing) — dump everything and filter here.
	const out = execFileSync(
		process.execPath,
		['--print-bytecode', '--print-bytecode-filter=*', bundle],
		{ cwd: pkgRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
	);
	// Node-internal functions share names with ours (`write`, `run`); they
	// compile during bootstrap, before the smoke's marker line — parse only
	// after it. (Within the smoke, same-name collisions keep the max, which
	// is conservative for the budget.)
	const markerAt = out.lastIndexOf('@@SMOKE-START');
	expect(markerAt, 'smoke marker missing from --print-bytecode output').toBeGreaterThanOrEqual(0);
	const sizes = new Map<string, number>();
	let current: string | undefined;
	for (const line of out.slice(markerAt).split('\n')) {
		const header = /^\[generated bytecode for function: ([A-Za-z_$][\w$]*)/.exec(line);
		if (header) {
			current = header[1];
			continue;
		}
		const len = /^Bytecode length: (\d+)/.exec(line);
		if (len && current !== undefined) {
			sizes.set(current, Math.max(sizes.get(current) ?? 0, Number(len[1])));
			current = undefined;
		}
	}
	return sizes;
}

describe.skipIf(NODE_MAJOR !== 24)('bytecode budgets (esbuild-bundled smoke, Node 24)', () => {
	const sizes = measure();

	test('smoke exercises every budgeted function', () => {
		const missing = [...Object.keys(BUDGETS), ...Object.keys(OVER_LIMIT_PINS)].filter((name) => !sizes.has(name));
		expect(missing).toEqual([]);
	});

	test('no budgeted name was renamed by esbuild scope-merge', () => {
		// When two module-level functions share a name, esbuild renames one to
		// `name2`/`name3` in the bundle — and this suite would then measure the
		// WRONG symbol (or a bootstrap function) under the bare name while the
		// budgeted function escapes measurement. A `name2` in the dump for any
		// budgeted name means measurement integrity is broken: rename one of
		// the colliding source functions.
		const budgeted = [...Object.keys(BUDGETS), ...Object.keys(OVER_LIMIT_PINS)];
		const collided = budgeted.filter((name) => sizes.has(`${name}2`) || sizes.has(`${name}3`));
		expect(collided).toEqual([]);
	});

	for (const [name, budget] of Object.entries(BUDGETS)) {
		test(`${name} <= ${budget}`, () => {
			const size = sizes.get(name);
			expect(size, `bytecode length of ${name}`).toBeDefined();
			expect(size!).toBeLessThanOrEqual(budget);
			expect(budget).toBeLessThanOrEqual(INLINE_LIMIT);
		});
	}

	for (const [name, pin] of Object.entries(OVER_LIMIT_PINS)) {
		test(`${name} pinned at ${pin} (over the inline limit — TODO(B2))`, () => {
			const size = sizes.get(name);
			expect(size, `bytecode length of ${name}`).toBeDefined();
			expect(size!).toBeLessThanOrEqual(pin);
			// If a change brings it under the inline limit, promote it into
			// BUDGETS and delete the pin — that is B2's exit criterion.
			expect(size!, `${name} now fits the inline budget — move it to BUDGETS`).toBeGreaterThan(INLINE_LIMIT);
		});
	}
});
