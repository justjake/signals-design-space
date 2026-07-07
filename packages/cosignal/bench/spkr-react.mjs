// Measures retirement as React sees it: wall ms per committed update round
// for N components reading one shared atom through cosignal-react, against
// the same components on plain useState. COARSE timing (jsdom + act).
import { median, medianOfProcesses, stat } from './util.mjs';

const DIR = '/Users/jitl/src/alien-signals-opt/packages/cosignal/bench';
const PROCS = parseInt(process.env.PROCS ?? '5', 10);

const out = [];
for (const N of [8, 64]) {
	console.log(`== react-usestate N${N} ==`);
	const u = await medianOfProcesses(`${DIR}/spkr-react-usestate.mjs`, { N: String(N) }, PROCS);
	console.log(`== react-cosignal N${N} ==`);
	const c = await medianOfProcesses(`${DIR}/spkr-react-cosignal.mjs`, { N: String(N) }, PROCS);
	const uM = u.byMetric.get(`roundMs:N${N}`);
	const cM = c.byMetric.get(`roundMs:N${N}`);
	out.push({
		cell: `N${N}`,
		useStateMs: stat(uM, 3),
		cosignalMs: stat(cM, 3),
		ratio: (median(cM) / median(uM)).toFixed(2),
		steady: stat(c.byMetric.get(`steadyLog:N${N}`), 0),
	});
}
console.log('\nSPK-R react results (wall ms per update round; COARSE; median [min..max] across processes)');
console.table(out);
console.log(JSON.stringify(out, null, 1));
