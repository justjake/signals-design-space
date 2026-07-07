// Measures delivery fan-out: the logged build's per-write propagation cost
// and delivered/spurious re-render counts as watcher fan-out, batches per
// frame, and writes per frame grow — against the base build's per-write
// cost on the same graph (where equal writes are value-gated away).
import { median, medianOfProcesses, stat } from './util.mjs';

const DIR = '/Users/jitl/src/alien-signals-opt/packages/cosignals/bench';
const PROCS = parseInt(process.env.PROCS ?? '5', 10);

const GRID = [
	{ F: 1, B: 1, W: 8 },
	{ F: 8, B: 1, W: 8 },
	{ F: 64, B: 1, W: 8 },
	{ F: 8, B: 4, W: 8 },
	{ F: 8, B: 4, W: 64 },
	{ F: 64, B: 4, W: 64 },
	{ F: 8, B: 2, W: 64, HELD: 1 },
	{ F: 8, B: 2, W: 64, INTERLEAVE: 1 },
];

const directCache = new Map();
const out = [];
for (const cell of GRID) {
	const lshape = `F${cell.F}xB${cell.B}xW${cell.W}${cell.HELD ? '+held' : ''}${cell.INTERLEAVE ? '+inter' : ''}`;
	const dshape = `F${cell.F}xW${cell.W}`;
	console.log(`== logged ${lshape} ==`);
	const l = await medianOfProcesses(`${DIR}/spkn1-logged.mjs`, {
		F: String(cell.F), B: String(cell.B), W: String(cell.W), HELD: String(cell.HELD ?? 0),
		INTERLEAVE: String(cell.INTERLEAVE ?? 0),
	}, PROCS);
	if (!directCache.has(dshape)) {
		console.log(`== direct ${dshape} ==`);
		directCache.set(dshape, await medianOfProcesses(`${DIR}/spkn1-direct.mjs`, {
			F: String(cell.F), W: String(cell.W),
		}, PROCS));
	}
	const d = directCache.get(dshape);
	const lP = l.byMetric.get(`propNs:${lshape}`);
	const dP = d.byMetric.get(`propNs:${dshape}`);
	out.push({
		cell: lshape,
		directPropNs: stat(dP),
		loggedPropNs: stat(lP),
		ratio: (median(lP) / median(dP)).toFixed(1),
		frameNsLogged: stat(l.byMetric.get(`frameNs:${lshape}`), 0),
		maxDelivPerWB: stat(l.byMetric.get(`maxDeliv:${lshape}`), 0),
		maxSpuriousPerWB: stat(l.byMetric.get(`maxSpurious:${lshape}`), 0),
		logLenEnd: stat(l.byMetric.get(`logLen:${lshape}`), 0),
		heldDegrade: stat(l.byMetric.get(`degrade:${lshape}`), 2),
	});
}
console.log('\nSPK-N1 results (propagate ns/write; median [min..max] across processes)');
console.table(out);
console.log(JSON.stringify(out, null, 1));
