// Measures the quiet residual of loading the concurrent engine: per-op ns of
// plain (unregistered) signals with the logged build armed but idle, against
// the base build on identical workloads. Best run on an idle machine; 7
// processes per config for tighter medians.
import { median, medianOfProcesses, stat } from './util.mjs';

const DIR = '/Users/jitl/src/alien-signals-opt/packages/cosignals/bench';
const PROCS = parseInt(process.env.PROCS ?? '7', 10);
const SHAPES = ['readPoll', 'deepPropagate', 'broadIsolate', 'diamond'];

const out = [];
for (const shape of SHAPES) {
	console.log(`== direct ${shape} ==`);
	const d = await medianOfProcesses(`${DIR}/spkl-direct.mjs`, { SHAPE: shape }, PROCS);
	console.log(`== logged-quiet ${shape} ==`);
	const l = await medianOfProcesses(`${DIR}/spkl-logged.mjs`, { SHAPE: shape }, PROCS);
	const dOp = d.byMetric.get(`opNs:${shape}`);
	const lOp = l.byMetric.get(`opNs:${shape}`);
	out.push({
		shape,
		directNs: stat(dOp, 2),
		loggedQuietNs: stat(lOp, 2),
		residualPct: (((median(lOp) - median(dOp)) / median(dOp)) * 100).toFixed(2),
	});
}
console.log('\nSPK-L results (per-op ns; median [min..max] across processes; LOADED MACHINE — see doc header)');
console.table(out);
console.log(JSON.stringify(out, null, 1));
