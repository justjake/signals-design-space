// NF2 P2.S-A bench gates (plans/2026-07-06 §4.9.6): the two staged gates,
// each ≤ 1.4× the head-bridge anchor; breach = mid-stage STOP.
//
//  - cold-render: N=200 quiet computeds, first render — per-computed cold
//    world read in a fresh render (prices the §4.4.8 fast-path deletion).
//  - wide-mask lock-in: one commit locking in a batch with W=200
//    atomsTouched against a committed arena shadowing all of them —
//    end-to-end commit+drain cost (site-(b) fan + refold burst).
//
// Run twice and compare (same script, both trees):
//   COSIGNAL_ROOT=<head-worktree> node --expose-gc --import tsx spka-sa-gates.mjs   → anchor
//   COSIGNAL_ROOT=<repo>          node --expose-gc --import tsx spka-sa-gates.mjs   → S-A
import process from 'node:process'

const ROOT = process.env.COSIGNAL_ROOT ?? '/Users/jitl/src/alien-signals-opt'
// The engine module moved (concurrent.ts fused into CosignalEngine.ts);
// this bench drives A/B across generations, so try the fused module first
// and fall back to the old path on pre-fusion trees.
let mod = await import(`${ROOT}/packages/cosignals/src/CosignalEngine.ts`)
if (mod.engine === undefined) mod = await import(`${ROOT}/packages/cosignals/src/concurrent.ts`)

/**
 * A/B seam (COSIGNAL_ROOT swaps trees): the anchor tree constructs one
 * bridge per shape; the fused tree resets its default instance between
 * shapes (`__TEST__resetEngine`; `__resetEngineForTest` on pre-fusion trees).
 * The reset asserts quiescence — both
 * shapes below already end quiescent (every render ends, every batch
 * retires at commit) — and the drain below is insurance for leftovers.
 */
function acquireEngine() {
	if (typeof mod.__newBridgeForTest === 'function') {
		const b = mod.__newBridgeForTest()
		b.registerBridge()
		// Pre-rename trees expose the render frame as pass*: alias so one
		// script drives both sides of the A/B.
		if (b.renderStart === undefined) {
			b.renderStart = b.passStart
			b.renderEnd = b.passEnd
			b.renderValue = b.passValue
		}
		return b
	}
	const e = mod.engine
	e.discardAllWip()
	for (const t of e.liveBatches()) t.parked ? e.settleAction(t.id) : e.retire(t.id)
	;(mod.__TEST__resetEngine ?? mod.__resetEngineForTest)()
	return e
}

const REPS = Number(process.env.REPS ?? 15)
const N = 200

function median(xs) {
	const s = [...xs].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function coldRender() {
	const b = acquireEngine()
	const atoms = Array.from({ length: N }, (_, i) => b.atom(`a${i}`, i))
	const comps = Array.from({ length: N }, (_, i) =>
		b.computed(`c${i}`, (read) => Number(read(atoms[i])) + Number(read(atoms[(i + 1) % N]))),
	)
	// A committed consumer exists (mounted-quiet app state), so the committed
	// arena is populated and renders claim pooled arenas.
	const sum = b.computed('sum', (read) => Number(read(atoms[0])) + Number(read(atoms[N - 1])))
	const p0 = b.renderStart('R', [])
	b.mountWatcher(p0.id, sum, 'W')
	b.renderEnd(p0.id, 'commit')
	let checksum = 0
	const times = []
	for (let r = 0; r < REPS + 3; r++) {
		globalThis.gc?.()
		const t0 = process.hrtime.bigint()
		const p = b.renderStart('R', [])
		for (let i = 0; i < N; i++) checksum += Number(b.renderValue(comps[i], p))
		b.renderEnd(p.id, 'discard')
		const t1 = process.hrtime.bigint()
		if (r >= 3) times.push(Number(t1 - t0) / N) // per-computed cold read ns
	}
	return { ns: median(times), checksum }
}

function wideMask() {
	const b = acquireEngine()
	const atoms = Array.from({ length: N }, (_, i) => b.atom(`a${i}`, i))
	const c = b.computed('wide', (read) => {
		let s = 0
		for (let i = 0; i < N; i++) s += Number(read(atoms[i]))
		return s
	})
	const p0 = b.renderStart('R', [])
	const w = b.mountWatcher(p0.id, c, 'W')
	b.renderEnd(p0.id, 'commit') // committed arena now shadows all 200 atoms + c
	let checksum = 0
	const times = []
	for (let r = 0; r < REPS + 3; r++) {
		const t = b.openBatch()
		for (let i = 0; i < N; i++) b.write(t.id, atoms[i], 0, i + r)
		const p = b.renderStart('R', [t.id])
		b.renderWatcher(p.id, w.id)
		globalThis.gc?.()
		const t0 = process.hrtime.bigint()
		b.renderEnd(p.id, 'commit', { retireAtCommit: [t.id] }) // lock-in fan + drain refold burst
		const t1 = process.hrtime.bigint()
		checksum += Number(b.committedValue(c, 'R'))
		if (r >= 3) times.push(Number(t1 - t0) / 1000) // µs per commit+drain
	}
	return { us: median(times), checksum }
}

const cp = coldRender()
const wm = wideMask()
console.log(
	`@@ROW ${JSON.stringify({ gate: 'S-A', shape: 'cold-render', metric: 'perComputedColdReadNs', value: cp.ns, checksum: cp.checksum, root: ROOT })}`,
)
console.log(
	`@@ROW ${JSON.stringify({ gate: 'S-A', shape: 'wide-mask-lock-in', metric: 'commitDrainUs', value: wm.us, checksum: wm.checksum, root: ROOT })}`,
)
