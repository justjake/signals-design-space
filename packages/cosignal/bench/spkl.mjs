/**
 * SPK-L parent — LOGGED-quiet residual (O19). Pre-registered decision:
 * "G-Q's ≤2% vs the measured 2.4–3.8% branch floor: SPK-L (idle machine)
 * decides; pre-registered monitor renegotiation to ≤3% or the mitigation
 * ladder." Canonical SPK-L wants an IDLE machine; this run is best-effort
 * on a loaded machine (load disclosed in the results doc) — label results
 * accordingly. 7 processes per config for tighter medians.
 */
import { median, medianOfProcesses, stat } from './util.mjs';

const DIR = '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench';
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
