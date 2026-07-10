// Base-build comparator for the fan-out measurement: F effects on c=a+1,
// W writes/frame alternating changed/equal values (the base build drops
// writes equal to the current value — the value-gated baseline the logged
// build's value-blind delivery is priced against). Writes are unbatched so
// propagation cost is per-write.
import {
	Atom,
	Computed,
	effect,
} from '/Users/jitl/src/alien-signals-opt/packages/cosignals/src/index.ts'
import { envInt, row } from '/Users/jitl/src/alien-signals-opt/packages/cosignals/bench/util.mjs'

const F = envInt('F', 8)
const W = envInt('W', 8)
const FRAMES = envInt('FRAMES', 30)
const REPS = envInt('REPS', 5)
const WARMUP = envInt('WARMUP', 1)

let sink = 0
const a = new Atom(0)
const c = new Computed(() => a.state + 1)
for (let i = 0; i < F; i++) {
	effect(() => {
		sink += c.state
	})
}

let v = 0
function repOnce() {
	let writeNs = 0
	let frameNsTot = 0
	for (let f = 0; f < FRAMES; f++) {
		const f0 = process.hrtime.bigint()
		for (let k = 0; k < W; k++) {
			const changed = k % 2 === 0
			const value = changed ? ++v : v
			const t0 = process.hrtime.bigint()
			a.set(value)
			const t1 = process.hrtime.bigint()
			writeNs += Number(t1 - t0)
		}
		const f1 = process.hrtime.bigint()
		frameNsTot += Number(f1 - f0)
	}
	return { writeNsPerWrite: writeNs / (FRAMES * W), frameNs: frameNsTot / FRAMES }
}

for (let r = 0; r < WARMUP; r++) {
	repOnce()
}
const acc = []
for (let r = 0; r < REPS; r++) {
	globalThis.gc?.()
	acc.push(repOnce())
}
const med = (key) => {
	const s = acc.map((x) => x[key]).sort((x, y) => x - y)
	return s[s.length >> 1]
}
const base = { gate: 'SPK-N1', config: 'direct', shape: `F${F}xW${W}`, checksum: c.state + sink }
row({ ...base, metric: `propNs:${base.shape}`, value: med('writeNsPerWrite') })
row({ ...base, metric: `frameNs:${base.shape}`, value: med('frameNs') })
