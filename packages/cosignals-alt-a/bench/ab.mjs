// §14 A/B: let-doubling planes vs const never-grow planes (preallocated).
const which = process.argv[2] ?? 'let'
const lib = await import(which === 'const' ? './dist/cosignals-const.js' : './dist/cosignals.js')
const { createCosignalEngine, createForkDouble } = lib
const big = { initialRecords: 1 << 16, initialLogRecords: 1 << 14, initialMemoRecords: 1 << 14 }
function fastestOf(fn, iters, reps = 7) {
	fn()
	let best = Infinity
	for (let r = 0; r < reps; ++r) {
		const t0 = performance.now()
		for (let i = 0; i < iters; ++i) fn()
		best = Math.min(best, (performance.now() - t0) / iters)
	}
	return best * 1e6
}
// deep: kernel-heavy DIRECT chain (plane-access-bound — where binding treatment shows)
{
	const e = createCosignalEngine(big)
	const a = e.atom(0)
	let prev = e.computed(() => a.state + 1)
	for (let i = 0; i < 50; ++i) {
		const p = prev
		prev = e.computed(() => p.state + 1)
	}
	const tail = prev
	e.effect(() => {
		tail.state
	})
	let x = 0
	console.log(`${which} deep: ${fastestOf(() => a.set(++x), 20000).toFixed(1)} ns/op`)
}
// w1: steady logged write
{
	const e = createCosignalEngine(big)
	const fork = createForkDouble()
	e.attachFork(fork)
	fork.registerRoot('root')
	const a = e.atom(0)
	const holder = fork.openBatch('deferred')
	holder.run(() => a.set(-1))
	let x = 0
	console.log(`${which} w1: ${fastestOf(() => a.set(++x), 100000).toFixed(1)} ns/op`)
}
// w2: marked-cone read
{
	const e = createCosignalEngine(big)
	const fork = createForkDouble()
	e.attachFork(fork)
	fork.registerRoot('root')
	const atoms = Array.from({ length: 16 }, (_, i) => e.atom(i))
	const c = e.computed(() => atoms.reduce((s, a) => s + a.state, 0))
	c.state
	const t = fork.openBatch('deferred')
	t.run(() => atoms[0].set(100))
	console.log(`${which} w2: ${fastestOf(() => c.state, 500000).toFixed(1)} ns/op`)
}
