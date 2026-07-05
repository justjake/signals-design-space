// Phase 1b acceptance runner: host-attached REGISTERED sync write (quiet
// mode) vs the raw kernel write (spkw-direct) on identical graph shapes.
// Criterion: quiet within ~10% of direct. ≥5 processes per config.
import { median, medianOfProcesses, stat } from './util.mjs';

const DIR = '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench';
const PROCS = parseInt(process.env.PROCS ?? '5', 10);
const SHAPES = ['bare', 'chain3', 'fan8', 'watch1'];

const out = [];
for (const shape of SHAPES) {
	console.log(`== direct ${shape} ==`);
	const d = await medianOfProcesses(`${DIR}/spkw-direct.mjs`, { SHAPE: shape }, PROCS);
	console.log(`== quiet ${shape} ==`);
	const q = await medianOfProcesses(`${DIR}/spkw-quiet.mjs`, { SHAPE: shape }, PROCS);
	const dW = d.byMetric.get(`writeNs:${shape}`);
	const qW = q.byMetric.get(`writeNs:${shape}`);
	out.push({
		shape,
		directNs: stat(dW, 2),
		quietNs: stat(qW, 2),
		overheadPct: (((median(qW) - median(dW)) / median(dW)) * 100).toFixed(2),
	});
}
console.log('\nSPK-W QUIET results (per-write ns; median [min..max] across processes)');
console.table(out);
console.log(JSON.stringify(out, null, 1));
