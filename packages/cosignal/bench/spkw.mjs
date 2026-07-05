/**
 * SPK-W parent — logged-write price gate.
 * Pre-registered rule (spec §7 "Logged write", OPEN.md SPK-W): LOGGED write
 * > 2x DIRECT write => fallback = inline-2 receipts / tape pooling (REPORT
 * ONLY, never implemented here).
 */
import { median, medianOfProcesses, stat } from './util.mjs';

const DIR = '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench';
const PROCS = parseInt(process.env.PROCS ?? '5', 10);
const SHAPES = ['bare', 'chain3', 'fan8', 'watch1'];

const out = [];
for (const shape of SHAPES) {
	console.log(`== direct ${shape} ==`);
	const d = await medianOfProcesses(`${DIR}/spkw-direct.mjs`, { SHAPE: shape }, PROCS);
	console.log(`== logged ${shape} ==`);
	const l = await medianOfProcesses(`${DIR}/spkw-logged.mjs`, { SHAPE: shape }, PROCS);
	const dW = d.byMetric.get(`writeNs:${shape}`);
	const lW = l.byMetric.get(`writeNs:${shape}`);
	const lA = l.byMetric.get(`amortNs:${shape}`);
	out.push({
		shape,
		directNs: stat(dW),
		loggedNs: stat(lW),
		amortNs: stat(lA),
		ratio: (median(lW) / median(dW)).toFixed(1),
		evalsPerWrite: stat(l.byMetric.get(`evalsPerWrite:${shape}`), 2),
		eventsPerWrite: stat(l.byMetric.get(`eventsPerWrite:${shape}`), 2),
		deliv: stat(l.byMetric.get(`deliveriesPerWrite:${shape}`) ?? [0], 3),
		suppr: stat(l.byMetric.get(`suppressedPerWrite:${shape}`) ?? [0], 3),
	});
}
console.log('\nSPK-W results (per-write ns; median [min..max] across processes)');
console.table(out);
console.log(JSON.stringify(out, null, 1));
