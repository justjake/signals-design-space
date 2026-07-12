import { describe, expect, it } from 'vitest'
import { createCosignalEngine } from '../src/engine'
import { createForkDouble } from '../src/fork-double'

// §14 — reclamation: deterministic reclaim (the FinalizationRegistry's
// callback path) and the conservative guards. Actual GC-driven finalization
// is exercised only under --expose-gc (skipped otherwise).

describe('§14.2 reclamation', () => {
	it('deterministic reclaim frees unreferenced atom/computed records', () => {
		const e = createCosignalEngine({ finalization: true })
		const a = e.atom(1)
		const c = e.computed(() => a.state + 1)
		expect(c.state).toBe(2)
		e.reclaim(c) // computed with no subscribers: freed (deps dropped)
		e.reclaim(a) // atom with no subscribers: freed
		e.debug.verify()
		// Records are recycled: new nodes may reuse them without corruption.
		const b = e.atom(5)
		const d = e.computed(() => b.state * 2)
		expect(d.state).toBe(10)
		e.debug.verify()
	})

	it('never reclaims a node with live subscribers or a live tape', () => {
		const e = createCosignalEngine({ finalization: true })
		const fork = createForkDouble()
		e.attachFork(fork)
		fork.registerRoot('root')
		const a = e.atom(1)
		const c = e.computed(() => a.state + 1)
		let runs = 0
		const dispose = e.effect(() => {
			c.state
			++runs
		})
		e.reclaim(c) // guarded: c has a live subscriber (the effect)
		a.set(2)
		expect(runs).toBe(2) // still wired
		fork.closeEvent()
		// A logged atom is owned by the sweep lifecycle.
		const t = fork.openBatch('deferred')
		t.run(() => a.set(9))
		e.reclaim(a) // guarded: LOGGED
		expect(e.debug.readWorld(a, { kind: 'writer', token: t.token })).toBe(9)
		t.retire()
		dispose()
		e.debug.verify()
	})

	it.runIf(typeof globalThis.gc === 'function')(
		'GC-driven finalization reclaims dropped handles (--expose-gc only)',
		async () => {
			const e = createCosignalEngine({ finalization: true })
			for (let i = 0; i < 100; ++i) {
				e.atom(i) // dropped immediately
			}
			;(globalThis.gc as () => void)()
			await new Promise((r) => setTimeout(r, 10))
			e.debug.verify() // finalizer callbacks must not corrupt the planes
		},
	)
})
