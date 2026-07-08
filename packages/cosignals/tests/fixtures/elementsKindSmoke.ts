/**
 * Elements-kind smoke (P2 shape probe, run by tests/elements-kind.spec.ts
 * under `node --allow-natives-syntax`): drives realistic engine traffic —
 * link-heavy graphs (node and link records share the kernel's one allocator,
 * so record IDS are sparse over nodes), watcher mounts, batched writes,
 * renders, and dispose→create churn with record reuse — then asserts every
 * nodeIndex-keyed engine column is still a PACKED (non-holey) V8 array.
 * Record-ID indexing would go holey/dictionary here; nodeIndex indexing must
 * not. Natives are reached via `new Function` (the `%` syntax would not parse
 * in this bundled module otherwise).
 */
import { Atom, Computed, effect } from '../../src/index';
import { engine, __TEST__columns, type AtomInternals, type CosignalEngine, type Watcher } from '../../src/CosignalEngine';

const hasHoley = new Function('a', 'return %HasHoleyElements(a);') as (a: unknown) => boolean;
const isSmi = new Function('a', 'return %HasSmiElements(a);') as (a: unknown) => boolean;

// Probe self-check: a deliberately holey array must register as holey.
{
	const holey: number[] = [];
	holey[10] = 1; // write past length: 0..9 are holes
	if (!hasHoley(holey)) {
		console.error('elements-kind probe self-check failed: %HasHoleyElements missed a real hole');
		process.exit(2);
	}
}

function mount(b: CosignalEngine, root: string, node: unknown, name: string): Watcher {
	const p = b.renderStart(root, []);
	const w = b.mountWatcher(p.id, node as never, name);
	b.renderEnd(p.id, 'commit');
	return w;
}

function commitWrite(b: CosignalEngine, node: AtomInternals, value: unknown): void {
	const t = b.openBatch();
	b.write(t.id, node, 0, value);
	b.retire(t.id);
}

// THE one engine (always-concurrent; a fresh process needs no reset).
const b = engine;

// Link-heavy topology: each computed's evaluation allocates one node record
// and MANY link records (kernel + arena), so node records land on widely
// spaced record ids while their nodeIndexes stay dense.
const atoms = Array.from({ length: 40 }, (_, i) => b.atom(`a${i}`, i));
const sums = Array.from({ length: 10 }, (_, k) =>
	b.computed(`sum${k}`, (read) => atoms.reduce((s, n) => s + (read(n) as number), 0) + k));
const watchers = sums.map((c, k) => mount(b, 'R', c, `W${k}`));

// Plain kernel traffic interleaved: unregistered records (effects and their
// links) consume node slots and indexes between engine registrations.
const stops: (() => void)[] = [];
for (let i = 0; i < 25; i++) {
	const src = new Atom(i);
	stops.push(effect(() => { void src.state; }));
	const engineAtom = b.atom(`ia${i}`, i); // registration after unregistered slots: the gap-fill path
	commitWrite(b, engineAtom, i + 1);
}

// Batched write traffic over the live watchers (delivery walks, drains).
for (let i = 1; i <= 50; i++) commitWrite(b, atoms[i % atoms.length]!, i * 3);

// Dispose→create churn with record reuse (the nodeIndex recycling path).
const base = new Atom(1);
for (let i = 0; i < 120; i++) {
	const c = new Computed(() => (base.state as number) + i);
	const node = b.internalsForComputed(c as unknown as Computed<unknown>);
	b.committedValue(node, 'R');
	b.disposeComputed(c as unknown as Computed<unknown>);
}
for (const stop of stops) stop();
for (const w of watchers) b.removeWatcher(w.id);

// ---- the probes ------------------------------------------------------------
type Probe = { name: string; arr: unknown; smi: boolean };
const columns = __TEST__columns();
const probes: Probe[] = [
	{ name: 'nodeIndexToInternals', arr: columns.nodeIndexToInternals, smi: false },
	{ name: 'lastWalk', arr: columns.lastWalk, smi: true },
	{ name: 'evalMark', arr: columns.evalMark, smi: true },
	{ name: 'obsRefs', arr: columns.obsRefs, smi: true },
	{ name: 'obsDeps', arr: columns.obsDeps, smi: false },
	{ name: 'nodeToWatchers', arr: columns.nodeToWatchers, smi: false },
	{ name: 'committed-arena nodeToShadow', arr: b.__TEST__arena('R')!.nodeToShadow, smi: true },
];
let failed = false;
for (const p of probes) {
	if (!Array.isArray(p.arr)) {
		console.error(`elements-kind probe: ${p.name} is not an array (re-keying moved it?)`);
		failed = true;
		continue;
	}
	if (hasHoley(p.arr)) {
		console.error(`elements-kind probe: ${p.name} went HOLEY (length ${(p.arr as unknown[]).length})`);
		failed = true;
	}
	if (p.smi && !isSmi(p.arr)) {
		console.error(`elements-kind probe: ${p.name} left PACKED_SMI (length ${(p.arr as unknown[]).length})`);
		failed = true;
	}
}
if (failed) process.exit(1);
process.stdout.write('@@ELEMENTS-OK\n');
