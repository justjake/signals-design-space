/**
 * The twin-build promise:
 *  - the base entry's module graph never reaches concurrent-engine code
 *    (its source is import-free — the graph is exactly {src/index.ts} —
 *    and the exports map gives bundlers two disjoint entries);
 *  - arming the LOGGED table (registerReactBridge → __installTwinTable →
 *    closure rebuild over carried buffers) does not change public semantics
 *    while the bridge is quiet — the full 179-case conformance suite also
 *    runs against the logged build to pin that claim end to end (see the
 *    README's Testing section); here we pin the core behaviors plus the
 *    armed-table routing that IS new: public writes to bridge-registered
 *    atoms classify into the ambient default batch and record receipts,
 *    and public reads of registered atoms inside a world evaluation serve
 *    that world's fold.
 *
 * NOTE: arming is process-wide and vitest isolates test FILES, so this file
 * arms once in the first test and stays armed for the rest.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	__newBridgeForTest,
	Atom,
	batch,
	Computed,
	effect,
	ReducerAtom,
	registerReactBridge,
	untracked,
	type CosignalBridge,
} from '../src/logged.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('twin-build separation', () => {
	it('the DIRECT entry is import-free: its module graph is exactly {src/index.ts}', () => {
		const src = stripComments(readFileSync(join(pkgDir, 'src/index.ts'), 'utf8'));
		expect(src).not.toMatch(/(^|\n)\s*import\b/);
		expect(src).not.toMatch(/\bfrom\s+['"]/);
		expect(src).not.toMatch(/\brequire\s*\(/);
		expect(src).not.toContain('./logged');
	});

	it('the LOGGED entry imports the DIRECT entry (shared kernel), never the reverse', () => {
		const src = stripComments(readFileSync(join(pkgDir, 'src/logged.ts'), 'utf8'));
		expect(src).toMatch(/from '\.\/index\.js'/);
	});

	it('package.json exposes the two entries disjointly', () => {
		const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
			exports: Record<string, string>;
		};
		expect(pkg.exports['.']).toBe('./src/index.ts');
		expect(pkg.exports['./logged']).toBe('./src/logged.ts');
	});
});

describe('LOGGED armed but quiet: DIRECT semantics preserved through the swapped table', () => {
	let bridge: CosignalBridge;

	it('registerReactBridge arms exactly once and swaps the table at a boundary', () => {
		bridge = registerReactBridge();
		expect(bridge.mode).toBe('logged');
		expect(() => registerReactBridge()).toThrow(/only be called once/);
	});

	it('unregistered atoms/computeds/effects behave exactly as DIRECT (values, laziness, batching)', () => {
		const a = new Atom(1);
		const b = new Atom(2);
		let pulls = 0;
		const sum = new Computed(() => {
			pulls++;
			return a.state + b.state;
		});
		expect(sum.state).toBe(3);
		expect(pulls).toBe(1);
		expect(sum.state).toBe(3);
		expect(pulls).toBe(1); // cached — no spurious recompute through the logged table
		const seen: number[] = [];
		const dispose = effect(() => {
			seen.push(sum.state);
		});
		batch(() => {
			a.set(10);
			b.set(20);
		});
		expect(seen).toEqual([3, 30]); // one flush at batch close, exactly as in the base build
		expect(untracked(() => sum.state)).toBe(30);
		dispose();
	});

	it('update/dispatch fold purity still throws through the POISON table', () => {
		const a = new Atom(1);
		const r = new ReducerAtom((s: number, action: number) => s + action, 0);
		expect(() => a.update(() => a.state + 1)).toThrow(/not allowed inside an update/);
		r.dispatch(5);
		expect(r.state).toBe(5);
	});

	it('public writes to a REGISTERED atom classify into the ambient default batch with receipts', () => {
		const la = bridge.atom('pub', 0);
		la.handle.set(7); // application code writing through the public API
		expect(la.tape).toHaveLength(1);
		expect(la.tape[0]!.op).toEqual({ kind: 'set', value: 7 });
		const ambient = bridge.ambientToken;
		expect(ambient).toBeDefined();
		expect(la.tape[0]!.token).toBe(ambient);
		expect(bridge.newestValue(la)).toBe(7); // writes apply to the kernel immediately
		expect(bridge.committedValue(la, 'A')).toBe(0); // not committed yet: no root committed the batch and it has not retired
		bridge.retire(ambient!, false);
		expect(bridge.committedValue(la, 'A')).toBe(7); // persistence never depends on subscription
		expect(la.tape).toHaveLength(0); // pin-free retirement compacts the prefix
	});

	it('adopted DIRECT-era atoms join as committed-only base state (§5.1 rule 2)', () => {
		const handle = new Atom(41);
		handle.set(42); // pre-registration history
		const la = bridge.adoptAtom('adopted', handle);
		expect(la.base).toBe(42);
		expect(la.tape).toHaveLength(0);
		expect(bridge.committedValue(la, 'A')).toBe(42);
	});

	it('public reads of a registered atom inside an overlay world evaluation serve the world fold', () => {
		const la = bridge.atom('routed', 0);
		const viaHandle = bridge.computed('viaHandle', () => la.handle.state as number); // NOT the reader — the public API
		const t = bridge.openBatch('deferred');
		bridge.write(t.id, la, { kind: 'set', value: 5 });
		expect(bridge.newestValue(viaHandle)).toBe(5); // newest = kernel plane
		const p = bridge.passStart('A', []); // t excluded
		expect(bridge.passValue(viaHandle, p)).toBe(0); // the world evaluation routes the public read: the excluded batch stays invisible
		bridge.passEnd(p.id, 'discard');
		bridge.retire(t.id, true);
		expect(bridge.committedValue(viaHandle, 'A')).toBe(5);
	});

	it('growth after arming rebuilds through the logged factory and carries state', () => {
		const before = new Atom(123);
		const fresh = __newBridgeForTest(); // second bridge instance for tests: replaces routing, seam stays armed
		fresh.registerBridge();
		expect(before.state).toBe(123); // carried buffers intact across the rebuild(s)
	});
});
