// Measures long-run growth of the logged build under continuous,
// never-quiescent traffic: steady-state heap growth (MB/h) and write-latency
// degradation. The main config truncates the diagnostic event stream at each
// sample to isolate the engine's own retained state; the retain config
// reports the unbounded event stream's growth separately (n=2, supplementary).
import { medianOfProcesses, stat } from './util.mjs';

const DIR = '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench';
const PROCS = parseInt(process.env.PROCS ?? '5', 10);
const DURATION_MS = process.env.DURATION_MS ?? '60000';
const PART = process.env.PART ?? 'both'; // truncate | retain | both (split runs to bound wall time)

let t;
let r;
if (PART !== 'retain') {
	console.log('== soak (events truncated at samples; gate planes) ==');
	t = await medianOfProcesses(`${DIR}/spkk1-logged.mjs`, { EVENTS: 'truncate', DURATION_MS }, PROCS, 200_000);
}
if (PART !== 'truncate') {
	console.log('== soak (events retained; reference-build liability, n=2) ==');
	// Methodology note: at this build's throughput an unbounded retained
	// event stream exceeds the heap well inside 60s — the liability row runs
	// a shorter soak and extrapolates per hour.
	const RETAIN_MS = process.env.RETAIN_MS ?? String(Math.min(Number(DURATION_MS), 10_000));
	r = await medianOfProcesses(`${DIR}/spkk1-logged.mjs`, { EVENTS: 'retain', DURATION_MS: RETAIN_MS }, 2, 200_000);
}

const g = (m) => t?.byMetric.get(m) ?? [NaN];
const out = {
	'gate planes MB/h': stat(g('mbPerHour'), 3),
	'walk degradation %': stat(g('walkDegradePct'), 2),
	'write ns first window': stat(g('writeNsFirstWin'), 0),
	'write ns last window': stat(g('writeNsLastWin'), 0),
	'K1 edges/h': stat(g('k1EdgesPerHour'), 0),
	'tape at end (receipts)': stat(g('tapeEnd'), 0),
	'batch records/h': stat(g('batchesPerHour'), 0),
	'render passes/h': stat(g('renderPassesPerHour'), 0),
	'events/h (allocated either way)': stat(g('eventsPerHour'), 0),
	'frames/s': stat(g('framesPerSec'), 0),
	'RETAIN events MB/h (n=2)': stat(r?.byMetric.get('mbPerHour') ?? [NaN], 2),
	'RETAIN walk degrade % (n=2)': stat(r?.byMetric.get('walkDegradePct') ?? [NaN], 2),
};
console.log('\nSPK-K1 results (median [min..max] across processes)');
console.log(JSON.stringify(out, null, 1));
