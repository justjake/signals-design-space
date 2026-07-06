/**
 * Bytecode budget regression test (dalien port study row 6). V8 only inlines
 * a function whose bytecode is under --max-inlined-bytecode-size (460 in
 * Node 24, 920 cumulative per optimized function), and typed-array field
 * access generates ~3x the bytecode of an object field load — a hot function
 * that drifts past 460 silently stops inlining and costs real time (dalien:
 * the monolithic link() at 475 never inlined; splitting measured -8..-13% on
 * propagation shapes; checkDirty at 543 could not inline into
 * run()/computedRead until split).
 *
 * cosignal ships TS source, so budgets are asserted against an
 * esbuild-BUNDLED smoke (const enums inline to literals — the codegen
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
// flush hot paths of the kernel and the shadow-arena walks of the
// concurrency engine — including the freelist alloc/free pair the row-2 fix
// rethreaded.
const BUDGETS: Record<string, number> = {
	// graph kernel (src/index.ts createEngine internals)
	link: 180, // 154: re-track fast path
	linkInsert: 380, // 327: out-of-line insertion tail
	unlink: 310, // 262
	propagate: 460, // 426: already close to the limit — watch it
	shallowPropagate: 130, // 106
	isValidLink: 60, // 47
	update: 90, // 74
	updateComputed: 420, // 362
	updateSignal: 80, // 62
	notify: 210, // 178
	run: 390, // 333
	purgeDeps: 80, // 66
	unlinkChildEffects: 100, // 82
	allocLink: 120, // 102
	freeLink: 40, // 27: threads the free list through spare field 7 (row 2)
	// public read/write paths
	read: 120, // 98
	write: 180, // 152
	computedRead: 110, // 86: hot/cold split entry
	computedReadSlow: 460, // 410: the out-of-line ladder — near the limit
	writeAtom: 120, // 100
	flush: 170, // 139
	// concurrency engine (src/concurrent.ts shadow arenas)
	aLink: 230, // 189
	aLinkInsert: 380, // 325
	aUnlink: 380, // 321
	aPropagate: 450, // 384
	aShallowPropagate: 140, // 112
	aPurgeDeps: 170, // 137
	aAllocLink: 90, // 71
	aFreeLink: 50, // 37: threads a.linkFree through L_VER (row 2 twin)
	shadowFor: 310, // 261
	aNoteAtom: 300, // 262: +41 for the probe-fusion consume branch (B1 cold-pass
	// shave — skips a full shadowFor per tracked atom read; pair-guard loads
	// are the price of stale-safety). Still 160+ under the inline limit.
	foldAtom: 420, // 358
	aUpdateShadow: 230, // 188
};

// Functions ALREADY over the V8 inline budget, pinned at current size.
// TODO(B2): the checkDirty family split (entry wrapper + shallow fast path +
// two-level fast path + stackless chainCheck + out-of-line loop — port study
// row 10) is the B2 batch; do NOT refactor here. A pin that drops under
// INLINE_LIMIT should move down into BUDGETS (deliberately).
const OVER_LIMIT_PINS: Record<string, number> = {
	checkDirty: 537, // TODO(B2): upstream-shape monolith (try/finally + loop)
	aCheckDirty: 567, // TODO(B2): shadow-arena walk twin (guard counters + W reloads)
	aUpdateComputed: 714, // TODO(B2): arena fold frame save/restore monolith
};

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smoke = path.join(pkgRoot, 'tests', 'fixtures', 'bytecodeSmoke.ts');
const esbuildBin = path.join(pkgRoot, 'node_modules', '.bin', 'esbuild');

function measure(): Map<string, number> {
	const outDir = mkdtempSync(path.join(tmpdir(), 'cosignal-bytecode-'));
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
	// Node-internal functions share names with ours (`read`, `write`, `run`);
	// they compile during bootstrap, BEFORE the smoke's marker line — parse
	// only after it. (Within the smoke, same-name collisions keep the max,
	// which is conservative for the budget.)
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
