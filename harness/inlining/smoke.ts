/**
 * Inlining-probe workload: drives ONE framework adapter through a fixed
 * reactive graph hot enough for TurboFan to optimize the kernel's
 * propagate/read/flush paths, prints the steady marker, then keeps running
 * the exact same shapes — so the parent probe (util/inline-probe.ts) can
 * split warmup noise from steady-state behavior.
 *
 * The spec bundles a tiny generated entry that statically imports ONE
 * adapter and calls runSmoke — never the adapter registry. Bundling the
 * registry would pull every framework into one bundle and esbuild would
 * rename colliding kernel functions (link -> link3), making trace names
 * unstable.
 *
 * One graph, held for the whole run:
 *   - 4 source signals
 *   - a diamond joined by a tail        → shallow/pending propagation
 *   - an 8-deep computed chain          → checkDirty walks
 *   - a dependency-toggling computed    → link/unlink re-track paths
 *   - two effects on the tails         → notify/run/flush
 *   - a computed read outside effects   → the pull-read entry points
 */
import type { AdapterComputed, FrameworkAdapter } from '../adapters/types'
import { STEADY_END_MARKER, STEADY_MARKER } from '../util/inline-probe'

export function runSmoke(adapter: FrameworkAdapter): void {
	const warmIters = Number(process.env.SMOKE_WARM ?? 50_000)
	const steadyIters = Number(process.env.SMOKE_STEADY ?? 10_000)

	let sink = 0
	const s0 = adapter.signal(1)
	const s1 = adapter.signal(2)
	const s2 = adapter.signal(3)
	const s3 = adapter.signal(4)

	let lazy!: AdapterComputed<number>
	const dispose = adapter.effectScope(() => {
		const d1 = adapter.computed(() => s0.read() + s1.read())
		const d2 = adapter.computed(() => (s0.read() * 2 + s2.read()) | 0)
		const dTail = adapter.computed(() => d1.read() + d2.read())
		let prev: AdapterComputed<number> = dTail
		for (let i = 0; i < 8; i++) {
			const p = prev
			prev = adapter.computed(() => (p.read() + 1) | 0)
		}
		const chainTail = prev
		const dyn = adapter.computed(() => ((s3.read() & 1) === 0 ? s1.read() : s2.read()))
		lazy = adapter.computed(() => (dTail.read() ^ chainTail.read()) | 0)
		adapter.effect(() => {
			sink = (sink ^ dTail.read()) | 0
		})
		adapter.effect(() => {
			sink = (sink ^ (chainTail.read() + dyn.read())) | 0
		})
	})

	function iteration(i: number): void {
		adapter.startBatch()
		s0.write(i)
		s3.write(i) // parity flips dyn's dependency set every iteration
		adapter.endBatch()
		sink = (sink ^ lazy.read()) | 0
		if ((i & 7) === 0) {
			adapter.startBatch()
			s1.write((i ^ 5) | 0)
			s2.write((i * 3) | 0)
			adapter.endBatch()
			sink = (sink ^ lazy.read()) | 0
		}
	}

	for (let i = 0; i < warmIters; i++) iteration(i)
	console.log(STEADY_MARKER)
	for (let i = warmIters; i < warmIters + steadyIters; i++) iteration(i)
	// Teardown runs OUTSIDE the steady bracket: dispose executes unlink/
	// boundary paths for the first time, and those first-execution deopts
	// are normal, not a deopt-loop signal.
	console.log(STEADY_END_MARKER)
	dispose()
	console.log('sink:', sink)
}
