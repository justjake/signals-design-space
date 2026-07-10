/**
 * Regression pins for the convergence-refactor fixes (adversarial review of
 * 179012e). Each test fails on the pre-fix engine and passes after the fix:
 *
 *  1. A committed SignalEffect must not run inside an open kernel effect frame
 *     (a core effect writing an atom on the quiet path): its routed `.state`
 *     reads only record dependency links at the outermost operation boundary.
 *  2. A quiet write from inside a running SignalEffect body schedules the
 *     sibling terminal's run at the same boundary instead of nest-throwing
 *     'SignalEffect runs do not nest' into the user's atom.set.
 *  3. Cross-instance handle use throws loudly (no silent wrong-arena reads).
 *  4. SuspendedRead is one module-level class shared by every instance, so the
 *     exported `instanceof SuspendedRead` holds across instances.
 *  5. createCosignals() reserves a small arena, so many instances stay cheap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	Atom,
	attachDriver,
	BATCH_NONE,
	createCosignals,
	effect,
	engine,
	isAtom,
	isComputed,
	SuspendedRead,
	__TEST__resetEngine,
} from '../src/index.js'

const minimalDriver = { currentBatch: () => BATCH_NONE, worldFor: () => undefined }

describe('bug 1: SignalEffect runner does not fire inside a kernel effect frame', () => {
	beforeEach(() => __TEST__resetEngine())
	afterEach(() => __TEST__resetEngine())

	it('keeps its dependency links when a core effect writes its input on the quiet path', () => {
		attachDriver(minimalDriver)
		const trigger = new Atom(0) // read only by the core effect (kernel) — no engine content
		const b = new Atom(100) // read by the SignalEffect (routed) — gains content

		let bodyRuns = 0
		const seen: number[] = []
		const eff = engine.mountSignalEffect('root-1', 'se')
		const body = (): void => {
			bodyRuns++
			seen.push(b.state) // routed committed read — records the arena dep link
		}
		eff.body = body
		engine.captureSignalEffectRun(eff.id, body) // mount run
		expect(bodyRuns).toBe(1)
		expect(eff.deps.length).toBe(1) // depends on b

		// A core effect whose body writes b when triggered. The write lands inside
		// the kernel flush frame (enterDepth > 0); the pre-fix engine ran the
		// SignalEffect right there, where b.state fails the routed-read guard and
		// records ZERO links, dropping the dep to nothing.
		const dispose = effect(() => {
			const t = trigger.state
			if (t > 0) {
				b.set(100 + t)
			}
		})

		trigger.set(1) // core effect writes b=101; SignalEffect must re-fire, links intact
		expect(bodyRuns).toBe(2)
		expect(seen[seen.length - 1]).toBe(101)
		expect(eff.deps.length).toBe(1) // still depends on b — the bug dropped this to 0

		trigger.set(2) // proves the dep edge is still live (would be dead after the bug)
		expect(bodyRuns).toBe(3)
		expect(seen[seen.length - 1]).toBe(102)
		expect(eff.deps.length).toBe(1)

		dispose()
	})
})

describe('bug 2: a quiet write from a SignalEffect body schedules siblings, never nest-throws', () => {
	beforeEach(() => __TEST__resetEngine())
	afterEach(() => __TEST__resetEngine())

	it('runs the sibling terminal instead of throwing into the body write', () => {
		attachDriver(minimalDriver)
		const p = new Atom(0) // A's input
		const q = new Atom(0) // A writes it; B reads it

		let bRuns = 0
		let lastQ = -1
		const B = engine.mountSignalEffect('root-1', 'B')
		const bodyB = (): void => {
			bRuns++
			lastQ = q.state
		}
		B.body = bodyB
		engine.captureSignalEffectRun(B.id, bodyB)
		expect(bRuns).toBe(1)

		let aRuns = 0
		const A = engine.mountSignalEffect('root-1', 'A')
		const bodyA = (): void => {
			aRuns++
			const v = p.state
			q.set(v + 1) // quiet write from inside a running SignalEffect body
		}
		A.body = bodyA
		// The pre-fix engine flushed dirty terminals inline from this write and
		// tried to run sibling B while A was active — throwing 'SignalEffect runs
		// do not nest' into A's q.set. The fix defers the sibling to the boundary.
		expect(() => engine.captureSignalEffectRun(A.id, bodyA)).not.toThrow()
		expect(aRuns).toBe(1)

		// A boundary (a public write) drains the deferred work: A re-runs on p and
		// its q write reaches sibling B — the sibling's due run is delivered.
		p.set(5)
		expect(aRuns).toBeGreaterThan(1)
		expect(bRuns).toBeGreaterThan(1)
		expect(lastQ).toBe(q.state) // B saw q's committed value

		engine.removeSignalEffect(A.id)
		engine.removeSignalEffect(B.id)
	})
})

describe('bug 3: cross-instance ownership guard', () => {
	it('throws a clear error for a handle used with a different engine instance', () => {
		const a = createCosignals()
		const b = createCosignals()
		const foreignAtom = new a.Atom(1)
		const foreignComputed: unknown = new a.Computed(() => 2)

		expect(() => b.engine.internalsForAtom(foreignAtom)).toThrow(/different engine instance/)
		expect(() =>
			b.engine.internalsForComputed(
				foreignComputed as Parameters<typeof b.engine.internalsForComputed>[0],
			),
		).toThrow(/different engine instance/)

		// The write surface guards too: foreign internals passed to b.engine.write/bareWrite.
		const foreignNode = a.engine.internalsForAtom(foreignAtom)
		expect(() => b.engine.bareWrite(foreignNode, 0, 9)).toThrow(/different engine instance/)
		expect(() => b.engine.write(undefined, foreignNode, 0, 9)).toThrow(/different engine instance/)

		// A handle used with its OWN instance is fine.
		const ownAtom = new b.Atom(0)
		expect(() => b.engine.internalsForAtom(ownAtom)).not.toThrow()
	})
})

describe('bug 4: SuspendedRead is one class shared across instances', () => {
	it('exposes the same class from every instance (instanceof holds across instances)', () => {
		const a = createCosignals()
		const b = createCosignals()
		expect(a.SuspendedRead).toBe(SuspendedRead)
		expect(b.SuspendedRead).toBe(SuspendedRead)
		// A carrier constructed by a per-instance class is instanceof the package export.
		const carrier = new a.SuspendedRead(Promise.resolve())
		expect(carrier instanceof SuspendedRead).toBe(true)
		expect(carrier instanceof b.SuspendedRead).toBe(true)
	})
})

describe('bug 5: createCosignals() does not eagerly reserve a large arena', () => {
	it('keeps N instances cheap (no ~120MB per instance)', () => {
		const before = process.memoryUsage().arrayBuffers
		const instances = []
		for (let i = 0; i < 50; i++) {
			instances.push(createCosignals())
		}
		const afterMB = (process.memoryUsage().arrayBuffers - before) / (1024 * 1024)
		// 50 instances at the old ~120MB floor would reserve ~6GB (and likely throw
		// on allocation); the small default keeps the whole batch well under 100MB.
		expect(afterMB).toBeLessThan(100)
		expect(instances.length).toBe(50) // keep them referenced (no GC before the measure)
	})

	it('honors an explicit initialRecords option', () => {
		const inst = createCosignals({ initialRecords: 2048 })
		const a = new inst.Atom(1)
		a.set(2)
		expect(a.state).toBe(2) // functional after opting into a larger floor
	})
})

describe('bug 8 foundation: brand-based handle detection across instances', () => {
	it('isAtom/isComputed recognize handles from any instance (instanceof would not)', () => {
		const a = createCosignals()
		const b = createCosignals()
		expect(isAtom(new a.Atom(0))).toBe(true)
		expect(isAtom(new b.ReducerAtom((s: number) => s, 0))).toBe(true) // ReducerAtom is an atom
		expect(isComputed(new a.Computed(() => 1))).toBe(true)
		// Per-instance `instanceof` would reject the other instance's handles; the
		// brand does not — this is what lets the React bindings accept them.
		expect(a.Atom).not.toBe(b.Atom)
		expect(isAtom(new b.Atom(0))).toBe(true)
		// Non-handles are rejected.
		expect(isAtom({})).toBe(false)
		expect(isComputed(new a.Atom(0))).toBe(false)
		expect(isAtom(null)).toBe(false)
	})
})
