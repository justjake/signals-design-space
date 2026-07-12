// Measures the price of a logged-build write: per-write ns of the logged
// build (log entry append + delivery walk) against the base build on the same
// graph shapes, plus evals/events/deliveries per write.
import { median, medianOfProcesses, stat } from './util.mjs'

const DIR = '/Users/jitl/src/alien-signals-opt/packages/cosignals/bench'
const PROCS = parseInt(process.env.PROCS ?? '5', 10)
const SHAPES = ['bare', 'chain3', 'fan8', 'watch1']

const out = []
for (const shape of SHAPES) {
	console.log(`== direct ${shape} ==`)
	const d = await medianOfProcesses(`${DIR}/spkw-direct.mjs`, { SHAPE: shape }, PROCS)
	console.log(`== logged ${shape} ==`)
	const l = await medianOfProcesses(`${DIR}/spkw-logged.mjs`, { SHAPE: shape }, PROCS)
	const dW = d.byMetric.get(`writeNs:${shape}`)
	const lW = l.byMetric.get(`writeNs:${shape}`)
	const lA = l.byMetric.get(`amortNs:${shape}`)
	out.push({
		shape,
		directNs: stat(dW),
		loggedNs: stat(lW),
		amortNs: stat(lA),
		ratio: (median(lW) / median(dW)).toFixed(1),
		evalsPerWrite: stat(l.byMetric.get(`evalsPerWrite:${shape}`), 2),
	})
}
console.log('\nSPK-W results (per-write ns; median [min..max] across processes)')
console.table(out)
console.log(JSON.stringify(out, null, 1))
