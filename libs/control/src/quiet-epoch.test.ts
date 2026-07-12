/**
 * Targeted unit tests for the two @lab/control optimizations, focused on the
 * edge cases identified in the QUIET EPOCH SOUNDNESS analysis (index.ts) and
 * the persistent-scratch-stack re-entrancy hazard (system.ts).
 *
 * Run:  pnpm -C harness exec tsx ../libs/control/src/quiet-epoch.test.ts
 *
 * Every test asserts *behavioral* invariants that must hold in all four flag
 * configurations; the __epochFastPathHits() === 0 assertions additionally
 * verify empirically that the sound quiet-epoch fast path never fires (the
 * unreachability theorem documented in index.ts).
 */
import assert from 'node:assert/strict'
import {
	__epochFastPathHits,
	computed,
	effect,
	endBatch,
	signal,
	startBatch,
	trigger,
} from './index.js'

let passed = 0
function test(name: string, fn: () => void): void {
	fn()
	passed++
	console.log(`ok - ${name}`)
}

// 1. Inner write during a computed's own recompute (the Recursed machinery).
// updateComputed must stamp the epoch captured BEFORE the getter ran: the
// inner S(1) write bumps the epoch mid-recompute, so the post-recompute
// Pending left on C must survive the fast path and force a real checkDirty.
// An implementation that stamped the epoch observed AFTER the getter would
// return the stale 100 on the third read.
test('inner write during recompute forces re-verification', () => {
	const T = signal(0)
	const S = signal(0)
	const D = computed(() => S() * 10)
	const C = computed(() => {
		const t = T()
		const d = D()
		if (t === 1) {
			S(1) // inner write: D (already read above) is now stale
		}
		return t * 100 + d
	})
	assert.equal(C(), 0)
	T(1)
	assert.equal(C(), 100) // recomputed with pre-write D value, left Pending
	assert.equal(C(), 110) // must checkDirty and see the fresh D
	assert.equal(C(), 110)
})

// 2. Verified-clean stamping vs. a later write: C is confirmed clean via
// checkDirty (B's equality cutoff), which stamps its verifyEpoch. The next
// write must bump past the stamp so C re-verifies instead of fast-pathing.
test('cutoff-verified computed re-verifies after a later write', () => {
	const A = signal(1)
	let bRuns = 0
	const B = computed(() => {
		bRuns++
		return A() % 2
	})
	const C = computed(() => B() * 3)
	assert.equal(C(), 3)
	A(3) // B recomputes to the same 1 -> cutoff -> C verified clean
	assert.equal(C(), 3)
	assert.equal(bRuns, 2)
	A(4) // must not be masked by C's fresh-looking verifyEpoch
	assert.equal(C(), 0)
	assert.equal(bRuns, 3)
})

// 3. Effect re-run whose cleanup writes an unrelated signal. The cleanup
// runs inside the flush (user code between epoch bumps); computeds hanging
// off the cleanup-written signal must see fresh values afterwards. Also
// covers updateComputed's entry capture happening before unwatched-driven
// cleanups can run user code.
test('effect cleanup writes keep unrelated computeds fresh', () => {
	const S = signal(0)
	const S2 = signal(0)
	const D = computed(() => S2() * 2)
	const C = computed(() => S())
	const dispose = effect(() => {
		C()
		return () => {
			S2(S2() + 1)
		}
	})
	assert.equal(D(), 0)
	S(1) // effect re-runs; cleanup bumps S2 first
	assert.equal(D(), 2)
	S(2)
	assert.equal(D(), 4)
	dispose() // final cleanup fires
	assert.equal(D(), 6)
})

// 4. trigger() must bump the epoch. It is the only propagate call site with
// no changed pendingValue. Setup: C2 recomputes at epoch E (stamped E, no
// later bump), then trigger() marks it Pending for an in-place mutation.
// Without trigger's bump, C2.verifyEpoch === currentEpoch and the fast path
// would return the stale 16 — the one construction where the fast path is
// reachable, guarded exactly by that bump.
test('trigger() bumps the epoch so transitive subs re-verify', () => {
	const obj = { a: 1 }
	const S = signal(obj)
	const K = signal(0)
	const C = computed(() => S().a + K())
	const C2 = computed(() => C() + 10)
	assert.equal(C2(), 11)
	K(5) // C2 recomputes and is stamped at the current epoch
	assert.equal(C2(), 16)
	obj.a = 2 // in-place mutation: no write, no bump
	trigger(() => {
		S()
	})
	assert.equal(C2(), 17)
})

// 5. Batched writes to disjoint subgraphs; each read must resolve its own
// region regardless of the interleaving of bumps and verifications.
test('batched writes across disjoint subgraphs', () => {
	const A = signal(1)
	const B = signal(10)
	const CA = computed(() => A() * 2)
	const CB = computed(() => B() * 2)
	const sum = computed(() => CA() + CB())
	assert.equal(sum(), 22)
	startBatch()
	A(2)
	assert.equal(sum(), 24) // read mid-batch: A committed, B untouched
	B(20)
	endBatch()
	assert.equal(sum(), 44)
})

// 6. Persistent-stack re-entrancy: checkDirty descends a pushed frame
// (B -> M), then update(M)'s getter reads the tail of a 1200-deep Pending
// chain, re-entering checkDirty while the outer activation is mid-flight.
// The base-pointer discipline must keep the two activations' frames apart
// (this also grows the stack well past any initial capacity).
test('re-entrant checkDirty with in-flight frames (deep chain)', () => {
	const N = 1200
	const S1 = signal(1)
	let prev: () => number = computed(() => S1() + 1)
	for (let i = 1; i < N; i++) {
		const p = prev
		prev = computed(() => p() + 1)
	}
	const tail = prev // tail() === S1 + N
	const S2 = signal(10)
	const M = computed(() => S2() + tail())
	const B = computed(() => M() + 0)
	assert.equal(B(), 10 + 1 + N)
	startBatch()
	S1(2) // marks the whole chain + M + B Pending
	S2(20) // early-terminates at the already-Pending M
	endBatch()
	assert.equal(B(), 20 + 2 + N)
})

// 7. Persistent-stack use in propagate: a binary tree of computeds (every
// node has two subscribers) forces a push at each branch point. All leaves
// are kept live by one effect each so propagate + notify covers the tree.
test('propagate through a branching tree with live leaves', () => {
	const W = signal(1)
	const depth = 8
	let layer: Array<() => number> = [computed(() => W() * 1)]
	for (let d = 1; d < depth; d++) {
		const nextLayer: Array<() => number> = []
		for (const node of layer) {
			nextLayer.push(computed(() => node() + 1))
			nextLayer.push(computed(() => node() + 1))
		}
		layer = nextLayer
	}
	let leafRuns = 0
	let leafSum = 0
	const disposers = layer.map((leaf) =>
		effect(() => {
			leafRuns++
			leafSum += leaf()
		}),
	)
	const leaves = 2 ** (depth - 1)
	assert.equal(leafRuns, leaves)
	assert.equal(leafSum, leaves * (1 + depth - 1))
	leafRuns = 0
	leafSum = 0
	W(2)
	assert.equal(leafRuns, leaves)
	assert.equal(leafSum, leaves * (2 + depth - 1))
	for (const d of disposers) {
		d()
	}
})

// 8. Exception safety: a getter that throws mid-checkDirty must not corrupt
// the persistent stacks (the finally restores the base pointer). Follow-up
// traversals — including the deep re-entrant shape from test 6 — must still
// work. The stale read after the throw is upstream v3.2.1's documented
// error-containment behavior (throwing computeds keep their old value and
// are treated as clean until the next write).
test('throwing getter mid-checkDirty leaves stacks consistent', () => {
	const S3 = signal(1)
	const bad = computed(() => {
		const v = S3()
		if (v === 2) {
			throw new Error('boom')
		}
		return v
	})
	const wrap = computed(() => bad() + 1)
	assert.equal(wrap(), 2)
	S3(2)
	assert.throws(() => wrap(), /boom/)
	assert.equal(wrap(), 2) // upstream parity: stale-but-clean after throw
	S3(3)
	assert.equal(wrap(), 4)

	// stacks still healthy: repeat a deep re-entrant traversal
	const S1 = signal(1)
	let prev: () => number = computed(() => S1() + 1)
	for (let i = 1; i < 500; i++) {
		const p = prev
		prev = computed(() => p() + 1)
	}
	const tailC = prev
	assert.equal(tailC(), 501)
	S1(2)
	assert.equal(tailC(), 502)
})

// The unreachability theorem, checked empirically across everything above:
// the sound quiet-epoch fast path never fires.
assert.equal(__epochFastPathHits(), 0, 'quiet-epoch fast path must not fire')
console.log(`ok - quiet-epoch fast path fired 0 times across all tests`)
console.log(`\n${passed + 1} checks passed`)
