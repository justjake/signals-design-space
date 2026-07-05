/**
 * SPK-R parent, core half — dense retirement vs DIRECT batch().
 * Pre-registered rule (spec §7 "Retirement (engine)", repaired SPLIT
 * comparator): "retirement engine overhead ≤ 2× a DIRECT batch() on the
 * identical write/effect graph; user callback time reported separately".
 * The old render-relative gate was DELETED (zero denominator) — not used.
 */
import { median, medianOfProcesses, stat } from './util.mjs';

const DIR = '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench';
const PROCS = parseInt(process.env.PROCS ?? '5', 10);

const CELLS = [
	{ K: 1, M: 8, WATCHERS: 0 },
	{ K: 8, M: 8, WATCHERS: 0 },
	{ K: 24, M: 8, WATCHERS: 0 },
	{ K: 8, M: 8, WATCHERS: 8 },
	{ K: 24, M: 8, WATCHERS: 8 },
];

const directCache = new Map();
const out = [];
for (const cell of CELLS) {
	const dshape = `K${cell.K}xM${cell.M}`;
	const lshape = `${dshape}${cell.WATCHERS > 0 ? `+${cell.WATCHERS}w` : ''}`;
	if (!directCache.has(dshape)) {
		console.log(`== direct ${dshape} ==`);
		directCache.set(dshape, await medianOfProcesses(`${DIR}/spkr-core-direct.mjs`, {
			K: String(cell.K), M: String(cell.M),
		}, PROCS));
	}
	console.log(`== logged ${lshape} ==`);
	const l = await medianOfProcesses(`${DIR}/spkr-core-logged.mjs`, {
		K: String(cell.K), M: String(cell.M), WATCHERS: String(cell.WATCHERS),
	}, PROCS);
	const d = directCache.get(dshape);
	const dB = d.byMetric.get(`batchNs:${dshape}`);
	const lR = l.byMetric.get(`retireNs:${lshape}`);
	const lW = l.byMetric.get(`writeNs:${lshape}`);
	const lT = l.byMetric.get(`totalNs:${lshape}`);
	out.push({
		cell: lshape,
		directBatchNs: stat(dB, 0),
		retireNsPerTok: stat(lR, 0),
		ratioRetire: (median(lR) / median(dB)).toFixed(1),
		writeNsPerTok: stat(lW, 0),
		totalNsPerTok: stat(lT, 0),
		ratioTotal: (median(lT) / median(dB)).toFixed(1),
	});
}
console.log('\nSPK-R core results (ns per batch/token; median [min..max] across processes)');
console.table(out);
console.log(JSON.stringify(out, null, 1));
