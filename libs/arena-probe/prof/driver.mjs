/**
 * Standalone prof driver — no harness/adapter layer. Mirrors shapes.ts's
 * deep/broad/diamond shapes but calls the library API directly.
 *
 * Usage:
 *   node prof/driver.mjs <lib> bench [reps] [scale]     # timing: fastest-of-reps per shape
 *   node prof/driver.mjs <lib> prof <shape> <scale>     # single big bounded run (for --prof/--cpu-prof)
 *
 * <lib>: probe | arena | alien  (or a path)
 */
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const LIBS = {
	probe: here('../src/index.ts'),
	arena: here('../../arena/src/index.ts'),
	alien: here('../../../upstream-alien-signals/esm/index.mjs'),
}

const libName = process.argv[2] ?? 'probe'
const mode = process.argv[3] ?? 'bench'
const { signal, computed, effect, effectScope } = await import(LIBS[libName] ?? libName)

// ---- shapes (mirror harness/bench/shapes.ts, direct API) --------------------

/** Chain of computeds; writes ripple the full depth. Stresses checkDirty. */
function deep(scale) {
	const D = 100
	const waves = 2000 * scale
	const src = signal(1)
	let last = src
	for (let i = 0; i < D; i++) {
		const prev = last
		last = computed(() => prev() + 1)
	}
	let seen = 0
	const dispose = effect(() => {
		seen = last()
	})
	for (let i = 0; i < waves; i++) src(i)
	dispose()
	return seen
}

/** One source fanning out to F computed+effect pairs. Stresses propagate. */
function broad(scale) {
	const F = 100
	const waves = 1000 * scale
	const src = signal(1)
	let sink = 0
	const disposers = []
	for (let i = 0; i < F; i++) {
		const c = computed(() => src() + i)
		disposers.push(
			effect(() => {
				sink += c()
			}),
		)
	}
	for (let i = 0; i < waves; i++) src(i)
	for (const d of disposers) d()
	return sink
}

/** Diamond: source → F branches → one join. Stresses mark/verify dedup. */
function diamond(scale) {
	const F = 50
	const waves = 1000 * scale
	const src = signal(1)
	const branches = []
	for (let i = 0; i < F; i++) branches.push(computed(() => src() + i))
	const join = computed(() => {
		let t = 0
		for (const b of branches) t += b()
		return t
	})
	let seen = 0
	const dispose = effect(() => {
		seen = join()
	})
	for (let i = 0; i < waves; i++) src(i)
	dispose()
	return seen
}

/** Computed whose dep set flips every wave. Stresses re-tracking/link churn. */
function dynamic(scale) {
	const waves = 2000 * scale
	const toggle = signal(false)
	const x = signal(1)
	const y = signal(2)
	const pick = computed(() => (toggle() ? x() : y()))
	let seen = 0
	const dispose = effect(() => {
		seen += pick()
	})
	for (let i = 0; i < waves; i++) {
		toggle(i % 2 === 0)
		if (i % 2 === 0) x(i)
		else y(i)
	}
	dispose()
	return seen
}

/** Build + tear down N signal→computed→effect rows. Stresses allocation. */
function create(scale) {
	const N = 10_000 * scale
	let count = 0
	const disposeScope = effectScope(() => {
		for (let i = 0; i < N; i++) {
			const s = signal(i)
			const c = computed(() => s() + 1)
			effect(() => {
				count += c()
			})
		}
	})
	disposeScope()
	return count
}

const SHAPES = { deep, broad, diamond, dynamic, create }

// ---- modes ------------------------------------------------------------------

if (mode === 'bench') {
	const reps = Number(process.argv[4] ?? '5')
	const scale = Number(process.argv[5] ?? '1')
	for (const [name, shape] of Object.entries(SHAPES)) {
		shape(1) // warmup (JIT tiers)
		let best = Infinity
		let checksum = 0
		for (let r = 0; r < reps; r++) {
			const t0 = performance.now()
			checksum = shape(scale)
			const ms = performance.now() - t0
			if (ms < best) best = ms
		}
		console.log(
			`@@ROW ${JSON.stringify({ lib: libName, shape: name, ms: +best.toFixed(2), checksum })}`,
		)
	}
} else if (mode === 'prof') {
	const shapeName = process.argv[4] ?? 'deep'
	const scale = Number(process.argv[5] ?? '10')
	const shape = SHAPES[shapeName]
	shape(1) // warmup
	const t0 = performance.now()
	const checksum = shape(scale)
	const ms = performance.now() - t0
	console.log(
		`@@PROF ${JSON.stringify({ lib: libName, shape: shapeName, scale, ms: +ms.toFixed(1), checksum })}`,
	)
} else {
	throw new Error(`unknown mode ${mode}`)
}
