/**
 * Standalone kairo/broadPropagation driver — no harness/adapter layer.
 * Mirrors milomg-reactivity-benchmark/packages/core/src/benches/kairo/broad.ts
 * exactly (50 rows of signal→computed→computed→effect, 51 batched writes per
 * iter, a top-level computed read after each write), but parameterized:
 *
 *   node --import tsx prof/kairo-broad.mjs <lib> bench [N] [W] [iters] [reps]
 *   node --import tsx prof/kairo-broad.mjs <lib> prof  [N] [W] [iters]
 *   node --import tsx prof/kairo-broad.mjs <lib> gc    [N] [W] [iters] [reps]
 *
 * <lib>: probe | arena | alien (or a path)
 * N = rows (fanout/effect count), default 50 (kairo size)
 * W = batched writes per iter, default 50 (kairo size)
 * iters = iter() calls per timing sample, default 500 (kairo size)
 * reps = samples, fastest wins, default 10 (kairo size)
 */
import { fileURLToPath } from 'node:url'
import { PerformanceObserver } from 'node:perf_hooks'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const LIBS = {
	probe: here('../src/index.ts'),
	arena: here('../../arena/src/index.ts'),
	alien: here('../../../upstream-alien-signals/esm/index.mjs'),
}

const libName = process.argv[2] ?? 'probe'
const mode = process.argv[3] ?? 'bench'
const N = Number(process.argv[4] ?? '50')
const W = Number(process.argv[5] ?? '50')
const ITERS = Number(process.argv[6] ?? '500')
const REPS = Number(process.argv[7] ?? '10')
// BRIDGE=1: mirror harness/bench/child.ts's toReactiveFramework layer exactly
// (adapter closures on read/write/computed, effect-body wrapper, effectScope
// around the build, withBatch try/finally).
const BRIDGE = process.env.BRIDGE === '1'
// Ablation knobs (direct mode): CHAIN=1 drops the middle computed (signal ->
// computed -> effect), BATCH=0 writes without startBatch/endBatch, READLAST=0
// drops the top-level computed read after each write. Defaults = exact kairo.
const CHAIN = Number(process.env.CHAIN ?? '2')
const BATCH = process.env.BATCH !== '0'
const READLAST = process.env.READLAST !== '0'
// POLLUTE=1: run kairo's avoidablePropagation + deepPropagation + triangle
// build/iter/dispose cycles first (bridged, scoped) to reproduce the harness
// process state (IC pollution + arena free-list scatter) before measuring.
const POLLUTE = process.env.POLLUTE === '1'

const lib = await import(LIBS[libName] ?? libName)
const { signal, computed, effect, effectScope, startBatch, endBatch } = lib

// ---- kairo broadPropagation, parameterized ----------------------------------

const counter = { count: 0 }

// Harness adapter layer (harness/adapters/{arena,alien-v3}.ts + child.ts bridge).
const bridge = {
	signal(initialValue) {
		const s = signal(initialValue)
		return { read: () => s(), write: (v) => s(v) }
	},
	computed(fn) {
		const c = computed(fn)
		return { read: () => c() }
	},
	effect(fn) {
		effect(() => {
			fn()
		})
	},
	withBatch(fn) {
		startBatch()
		try {
			fn()
		} finally {
			endBatch()
		}
	},
}

function buildDirect(n) {
	const head = signal(0)
	let last = head
	const disposers = []
	for (let i = 0; i < n; i++) {
		const current = computed(() => head() + i)
		const current2 = CHAIN === 2 ? computed(() => current() + 1) : current
		disposers.push(
			effect(() => {
				current2()
				counter.count++
			}),
		)
		last = current2
	}
	const off = CHAIN === 2 ? n : n - 1
	const iter = () => {
		if (BATCH) {
			startBatch()
		}
		head(1)
		if (BATCH) {
			endBatch()
		}
		counter.count = 0
		let bad = 0
		for (let i = 0; i < W; i++) {
			if (BATCH) {
				startBatch()
			}
			head(i)
			if (BATCH) {
				endBatch()
			}
			if (READLAST && last() !== i + off) {
				bad++
			}
		}
		if (bad !== 0 || counter.count !== W * n) {
			throw new Error(`checksum: bad=${bad} count=${counter.count} want=${W * n}`)
		}
	}
	const dispose = () => disposers.forEach((d) => d())
	return { iter, dispose }
}

// ---- pollution: run other kairo cases first (bridged + scoped, like harness) --

function polluteProcess() {
	const busy = () => {
		let a = 0
		for (let i = 0; i < 100; i++) {
			a++
		}
		return a
	}
	const cases = []
	// avoidablePropagation
	cases.push(() => {
		const head = bridge.signal(0)
		const c1 = bridge.computed(() => head.read())
		const c2 = bridge.computed(() => (c1.read(), 0))
		const c3 = bridge.computed(() => (busy(), c2.read() + 1))
		const c4 = bridge.computed(() => c3.read() + 2)
		const c5 = bridge.computed(() => c4.read() + 3)
		bridge.effect(() => {
			c5.read()
			busy()
		})
		return () => {
			bridge.withBatch(() => head.write(1))
			c5.read()
			for (let i = 0; i < 1000; i++) {
				bridge.withBatch(() => head.write(i))
				c5.read()
			}
		}
	})
	// deepPropagation
	cases.push(() => {
		const head = bridge.signal(0)
		let current = head
		for (let i = 0; i < 50; i++) {
			const c = current
			current = bridge.computed(() => c.read() + 1)
		}
		bridge.effect(() => {
			current.read()
			counter.count++
		})
		return () => {
			bridge.withBatch(() => head.write(1))
			for (let i = 0; i < 50; i++) {
				bridge.withBatch(() => head.write(i))
				current.read()
			}
		}
	})
	// triangle
	cases.push(() => {
		const head = bridge.signal(0)
		let current = head
		const list = []
		for (let i = 0; i < 10; i++) {
			const c = current
			list.push(current)
			current = bridge.computed(() => c.read() + 1)
		}
		const sum = bridge.computed(() => list.map((x) => x.read()).reduce((a, b) => a + b, 0))
		bridge.effect(() => {
			sum.read()
			counter.count++
		})
		return () => {
			bridge.withBatch(() => head.write(1))
			sum.read()
			for (let i = 0; i < 100; i++) {
				bridge.withBatch(() => head.write(i))
				sum.read()
			}
		}
	})
	for (const mk of cases) {
		let it
		const disposeScope = effectScope(() => {
			it = mk()
		})
		for (let i = 0; i < 30; i++) {
			it()
		}
		disposeScope()
	}
}

function buildBridged(n) {
	let iter
	const dispose = effectScope(() => {
		const head = bridge.signal(0)
		let last = head
		for (let i = 0; i < n; i++) {
			const current = bridge.computed(() => head.read() + i)
			const current2 = bridge.computed(() => current.read() + 1)
			bridge.effect(() => {
				current2.read()
				counter.count++
			})
			last = current2
		}
		iter = () => {
			bridge.withBatch(() => {
				head.write(1)
			})
			counter.count = 0
			let bad = 0
			for (let i = 0; i < W; i++) {
				bridge.withBatch(() => {
					head.write(i)
				})
				if (last.read() !== i + n) {
					bad++
				}
			}
			if (bad !== 0 || counter.count !== W * n) {
				throw new Error(`checksum: bad=${bad} count=${counter.count} want=${W * n}`)
			}
		}
	})
	return { iter, dispose }
}

const build = BRIDGE ? buildBridged : buildDirect

// ---- GC attribution ----------------------------------------------------------

let gcMs = 0
let gcCount = 0
const obs = new PerformanceObserver((list) => {
	for (const e of list.getEntries()) {
		gcMs += e.duration
		gcCount++
	}
})

// ---- modes -------------------------------------------------------------------

if (POLLUTE) {
	polluteProcess()
}

const { iter, dispose } = build(N)
// kairoBench warmup: run a few iters, let JIT tier up.
iter()
iter()
await new Promise((r) => setTimeout(r, 0))
iter()
await new Promise((r) => setTimeout(r, 0))

if (mode === 'bench' || mode === 'gc') {
	if (mode === 'gc') {
		obs.observe({ type: 'gc', buffered: false })
	}
	let best = Infinity
	let bestGcMs = 0
	let bestGcCount = 0
	for (let r = 0; r < REPS; r++) {
		gcMs = 0
		gcCount = 0
		const t0 = performance.now()
		for (let i = 0; i < ITERS; i++) {
			iter()
		}
		const ms = performance.now() - t0
		if (mode === 'gc') {
			await new Promise((r2) => setTimeout(r2, 0))
		} // deliver gc entries
		if (ms < best) {
			best = ms
			bestGcMs = gcMs
			bestGcCount = gcCount
		}
	}
	const row = { lib: libName, N, W, iters: ITERS, ms: +best.toFixed(2) }
	if (mode === 'gc') {
		row.gcMs = +bestGcMs.toFixed(2)
		row.gcCount = bestGcCount
	}
	console.log(`@@ROW ${JSON.stringify(row)}`)
} else if (mode === 'prof') {
	const t0 = performance.now()
	for (let i = 0; i < ITERS; i++) {
		iter()
	}
	const ms = performance.now() - t0
	console.log(`@@PROF ${JSON.stringify({ lib: libName, N, W, iters: ITERS, ms: +ms.toFixed(1) })}`)
} else {
	throw new Error(`unknown mode ${mode}`)
}
dispose()
