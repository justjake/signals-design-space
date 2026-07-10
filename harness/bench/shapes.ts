/**
 * Tier-0 iteration benchmark: tiny custom shapes, seconds total, for the dev
 * loop while optimizing a library. NOT for publication — use bench/run.ts
 * (full milomg suites, per-process, multi-pass) for the scoreboard.
 *
 * Method: one child process per framework (JIT isolation), every shape runs
 * REPS times in-child; we report min / p99-across-reps and per-rep GC time
 * observed via PerformanceObserver('gc'). The product is the RATIO column
 * against the first framework listed; absolute times are load-sensitive,
 * ratios within one invocation are not.
 *
 * WHAT THE EXTRA COLUMNS EXIST FOR (things fastest-of-N structurally hides):
 * - gc: total GC pause time + count inside the timed region — allocation
 *   pressure that min-time reporting selects away. Compare gc columns, not
 *   just ms columns, when judging arena/pool designs.
 * - p99 (shown when --reps >= 10): tail of the per-rep distribution — the
 *   reps that DID eat a GC pause or deopt. Use --reps 20 --scale 1 for a
 *   stable tail.
 *
 * Shapes for currently-invisible workload dimensions:
 * - reads:   pure quiet-read throughput on a clean graph (no writes at all)
 * - isolate: reads hammer subgraph B while writes hammer disjoint subgraph A
 *            — measures unrelated-write isolation. Push-marking designs
 *            (alien) keep B reads O(1); global-epoch pull designs (sweep)
 *            pay O(deps) revalidation on B per A-write. This is the shape
 *            that separates them.
 *
 * Parent usage (from repo root):
 *   pnpm -C harness exec tsx bench/shapes.ts --frameworks alien-v3,arena
 *   pnpm -C harness exec tsx bench/shapes.ts --frameworks alien-v3,sweep \
 *     --shapes reads,isolate,broad --reps 20
 *
 * Runtime selection: --runtime node|bun (default node). With bun, children
 * are spawned as `bun <this file>` (bun executes TS directly). JSC/bun does
 * not expose PerformanceObserver('gc'), so GC columns print gc:n/a there.
 *
 * Child protocol (spawned automatically): SHAPES_FRAMEWORK, SHAPES,
 * SHAPES_SCALE, SHAPES_REPS env vars; rows print as `@@ROW {json}`.
 *
 * Each shape computes a CHECKSUM; the parent cross-checks it between
 * frameworks and flags mismatches loudly — a fast wrong library is worthless.
 */
import { spawnSync } from 'node:child_process'
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { loadAdapter } from '../adapters/index'
import type { FrameworkAdapter } from '../adapters/types'

interface Row {
	shape: string
	framework: string
	ms: number // fastest rep
	p99: number // p99 across reps (== max for small rep counts)
	mean: number
	gcMs: number // total GC pause time across all reps
	gcN: number // GC count across all reps
	checksum: number
}

type Shape = (a: FrameworkAdapter, scale: number) => number // returns checksum

/** Chain of computeds; writes ripple the full depth. Stresses checkDirty. */
const deep: Shape = (a, scale) => {
	const D = 100
	const waves = Math.round(2000 * scale)
	const src = a.signal(1)
	let last: { read(): number } = src
	for (let i = 0; i < D; i++) {
		const prev = last
		last = a.computed(() => prev.read() + 1)
	}
	let seen = 0
	const dispose = a.effect(() => {
		seen = last.read()
	})
	for (let i = 0; i < waves; i++) {
		src.write(i)
	}
	dispose()
	return seen
}

/** One source fanning out to F computed+effect pairs. Stresses propagate. */
const broad: Shape = (a, scale) => {
	const F = 100
	const waves = Math.round(1000 * scale)
	const src = a.signal(1)
	let sink = 0
	const disposers: Array<() => void> = []
	for (let i = 0; i < F; i++) {
		const c = a.computed(() => src.read() + i)
		disposers.push(
			a.effect(() => {
				sink += c.read()
			}),
		)
	}
	for (let i = 0; i < waves; i++) {
		src.write(i)
	}
	for (const d of disposers) {
		d()
	}
	return sink
}

/** Diamond: source → F branches → one join. Stresses mark/verify dedup. */
const diamond: Shape = (a, scale) => {
	const F = 50
	const waves = Math.round(1000 * scale)
	const src = a.signal(1)
	const branches: Array<{ read(): number }> = []
	for (let i = 0; i < F; i++) {
		branches.push(a.computed(() => src.read() + i))
	}
	const join = a.computed(() => {
		let t = 0
		for (const b of branches) {
			t += b.read()
		}
		return t
	})
	let seen = 0
	const dispose = a.effect(() => {
		seen = join.read()
	})
	for (let i = 0; i < waves; i++) {
		src.write(i)
	}
	dispose()
	return seen
}

/** Computed whose dep set flips every wave. Stresses re-tracking/link churn. */
const dynamic: Shape = (a, scale) => {
	const waves = Math.round(2000 * scale)
	const toggle = a.signal(false)
	const x = a.signal(1)
	const y = a.signal(2)
	const pick = a.computed(() => (toggle.read() ? x.read() : y.read()))
	let seen = 0
	const dispose = a.effect(() => {
		seen += pick.read()
	})
	for (let i = 0; i < waves; i++) {
		toggle.write(i % 2 === 0)
		if (i % 2 === 0) {
			x.write(i)
		} else {
			y.write(i)
		}
	}
	dispose()
	return seen
}

/** Build + tear down N signal→computed→effect rows. Stresses allocation. */
const create: Shape = (a, scale) => {
	const N = Math.round(10_000 * scale)
	let count = 0
	const disposeScope = a.effectScope(() => {
		for (let i = 0; i < N; i++) {
			const s = a.signal(i)
			const c = a.computed(() => s.read() + 1)
			a.effect(() => {
				count += c.read()
			})
		}
	})
	disposeScope()
	return count
}

/** Unobserved write throughput: the write fast path with no live subs. */
const write: Shape = (a, scale) => {
	const N = Math.round(400_000 * scale)
	const s = a.signal(0)
	for (let i = 0; i < N; i++) {
		s.write(i)
	}
	return s.read()
}

/**
 * Pure quiet-read throughput: a settled 2-layer graph read many times with
 * ZERO writes. Measures the clean-read constant factor (flags check vs epoch
 * compare vs revalidation). Everyone should be O(1) per read — this shows
 * whose O(1) is smallest.
 */
const reads: Shape = (a, scale) => {
	const K = 50
	const rounds = Math.round(20_000 * scale)
	const sigs = Array.from({ length: K }, (_, i) => a.signal(i))
	const l1 = sigs.map((s) => a.computed(() => s.read() + 1))
	const l2 = l1.map((c, i) => a.computed(() => c.read() + l1[(i + 1) % K]!.read()))
	// settle everything once
	let sum = 0
	for (const c of l2) {
		sum += c.read()
	}
	for (let r = 0; r < rounds; r++) {
		for (let i = 0; i < K; i++) {
			sum += l2[i]!.read()
		}
	}
	return sum
}

/**
 * Unrelated-write isolation: subgraph A gets hammered with writes while
 * reads hammer disjoint subgraph B. Push-marking keeps B reads O(1);
 * global-epoch pull designs revalidate B's deps after every A write.
 */
const isolate: Shape = (a, scale) => {
	const rounds = Math.round(20_000 * scale)
	// subgraph A: signal -> computed -> effect (kept live so writes do real work)
	const aSrc = a.signal(0)
	const aC = a.computed(() => aSrc.read() + 1)
	let aSeen = 0
	const disposeA = a.effect(() => {
		aSeen = aC.read()
	})
	// subgraph B: disjoint chain read directly (lazy pull path)
	const K = 20
	const bSigs = Array.from({ length: K }, (_, i) => a.signal(i))
	const bComps = bSigs.map((s) => a.computed(() => s.read() * 2))
	let sum = 0
	for (const c of bComps) {
		sum += c.read()
	} // settle
	for (let r = 0; r < rounds; r++) {
		aSrc.write(r) // unrelated write
		for (let i = 0; i < K; i++) {
			sum += bComps[i]!.read()
		} // quiet reads of B
	}
	disposeA()
	return sum + aSeen
}

const SHAPES: Record<string, Shape> = {
	deep,
	broad,
	diamond,
	dynamic,
	create,
	write,
	reads,
	isolate,
}

async function runChild(): Promise<void> {
	const name = process.env.SHAPES_FRAMEWORK!
	const scale = Number(process.env.SHAPES_SCALE ?? '1')
	const reps = Number(process.env.SHAPES_REPS ?? '3')
	const wanted = (process.env.SHAPES ?? Object.keys(SHAPES).join(',')).split(',')
	const adapter = await loadAdapter(name as never)

	// GC observation. Node 24 quirk: observe({entryTypes:['gc']}) delivers
	// nothing; observe({type:'gc', buffered:true}) works but replays the whole
	// process's GC history and dispatches asynchronously. So: collect ALL gc
	// entries with their startTime, record a [t0,t1] window per shape, settle
	// at the end, and attribute entries to shapes by timestamp window.
	// Bun/JSC does not support the 'gc' entry type at all: report gcN = -1
	// (rendered as gc:n/a by the parent) instead of a misleading gc:0.
	// (cast: @types/node omits the static supportedEntryTypes on perf_hooks'
	// PerformanceObserver; it exists at runtime in both node and bun)
	const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] })
		.supportedEntryTypes
	const gcSupported = (supported ?? []).includes('gc')
	const gcEntries: Array<{ t: number; dur: number }> = []
	const obs = new PerformanceObserver((list) => {
		for (const e of list.getEntries()) {
			gcEntries.push({ t: e.startTime, dur: e.duration })
		}
	})
	if (gcSupported) {
		obs.observe({ type: 'gc', buffered: true })
	}

	interface Pending {
		shape: string
		times: number[]
		checksum: number
		window: [number, number]
	}
	const pending: Pending[] = []

	for (const shapeName of wanted) {
		const shape = SHAPES[shapeName]
		if (!shape) {
			continue
		}
		shape(adapter, 1) // warmup at scale 1 (JIT tiers), outside the window
		const times: number[] = []
		let checksum = 0
		const w0 = performance.now()
		for (let r = 0; r < reps; r++) {
			const t0 = performance.now()
			checksum = shape(adapter, scale)
			times.push(performance.now() - t0)
			// Yield to the macrotask queue between reps (outside the timed
			// window) so engine-scheduled work — FinalizationRegistry cleanup,
			// background GC finalization — runs as it would in a real app's
			// event loop. A fully synchronous rep loop systematically
			// overstates retention costs for finalizer-based reclamation.
			await new Promise<void>((res) => setImmediate(res))
		}
		pending.push({ shape: shapeName, times, checksum, window: [w0, performance.now()] })
	}

	// let late GC entries dispatch, then attribute and emit
	await new Promise((res) => setTimeout(res, 150))
	obs.disconnect()
	for (const p of pending) {
		const inWindow = gcEntries.filter((e) => e.t >= p.window[0] && e.t <= p.window[1])
		p.times.sort((x, y) => x - y)
		const row: Row = {
			shape: p.shape,
			framework: name,
			ms: p.times[0]!,
			p99: p.times[Math.min(p.times.length - 1, Math.floor(p.times.length * 0.99))]!,
			mean: p.times.reduce((s, t) => s + t, 0) / p.times.length,
			gcMs: gcSupported ? inWindow.reduce((s, e) => s + e.dur, 0) : 0,
			gcN: gcSupported ? inWindow.length : -1,
			checksum: p.checksum,
		}
		console.log(`@@ROW ${JSON.stringify(row)}`)
	}
}

function runParent(): void {
	const arg = (flag: string, dflt: string) => {
		const i = process.argv.indexOf(flag)
		return i >= 0 ? process.argv[i + 1] : dflt
	}
	const frameworks = arg('--frameworks', 'alien-v3').split(',')
	const shapes = arg('--shapes', Object.keys(SHAPES).join(','))
	const scale = arg('--scale', '1')
	const reps = Number(arg('--reps', '3'))
	const runtime = arg('--runtime', 'node')
	if (runtime !== 'node' && runtime !== 'bun') {
		console.error(`unknown --runtime ${JSON.stringify(runtime)}; expected node or bun`)
		process.exit(1)
	}
	// node children go through tsx (TS loader); bun executes TS natively.
	const [cmd, args] =
		runtime === 'bun'
			? (['bun', [fileURLToPath(import.meta.url)]] as const)
			: (['pnpm', ['exec', 'tsx', fileURLToPath(import.meta.url)]] as const)

	const rows: Row[] = []
	for (const fw of frameworks) {
		const t0 = performance.now()
		const res = spawnSync(cmd, [...args], {
			cwd: fileURLToPath(new URL('..', import.meta.url)),
			env: {
				...process.env,
				SHAPES_FRAMEWORK: fw,
				SHAPES: shapes,
				SHAPES_SCALE: scale,
				SHAPES_REPS: String(reps),
			},
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'inherit'],
		})
		if (res.status !== 0) {
			console.error(`child for ${fw} exited ${res.status}`)
			continue
		}
		for (const line of res.stdout.split('\n')) {
			if (line.startsWith('@@ROW ')) {
				rows.push(JSON.parse(line.slice(6)))
			}
		}
		console.error(
			`${fw} (${runtime}): child done in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
		)
	}

	const base = frameworks[0]
	const byShape = new Map<string, Map<string, Row>>()
	for (const r of rows) {
		if (!byShape.has(r.shape)) {
			byShape.set(r.shape, new Map())
		}
		byShape.get(r.shape)!.set(r.framework, r)
	}
	const pad = (s: string, n: number) => s.padEnd(n)
	const showP99 = reps >= 10
	const colW = showP99 ? 36 : 28
	console.log(`\nruntime: ${runtime}`)
	console.log(pad('shape', 10) + frameworks.map((f) => pad(f, colW)).join(''))
	for (const [shapeName, m] of byShape) {
		const baseRow = m.get(base!)
		let line = pad(shapeName, 10)
		for (const fw of frameworks) {
			const r = m.get(fw)
			if (!r) {
				line += pad('—', colW)
				continue
			}
			const ratio = baseRow && fw !== base ? ` (${(r.ms / baseRow.ms).toFixed(2)}x)` : ''
			const gc = r.gcN < 0 ? ' gc:n/a' : r.gcN > 0 ? ` gc:${r.gcMs.toFixed(1)}ms/${r.gcN}` : ' gc:0'
			const p99 = showP99 ? ` p99:${r.p99.toFixed(1)}` : ''
			line += pad(`${r.ms.toFixed(1)}ms${ratio}${gc}${p99}`, colW)
		}
		console.log(line)
		const sums = new Set([...m.values()].map((r) => r.checksum))
		if (sums.size > 1) {
			console.log(
				`  !! CHECKSUM MISMATCH on ${shapeName}: ` +
					[...m.entries()].map(([f, r]) => `${f}=${r.checksum}`).join(' '),
			)
		}
	}
}

if (process.env.SHAPES_FRAMEWORK) {
	runChild()
} else {
	runParent()
}
