/**
 * Arena-serving pins under the armed divergence check: the settlement
 * octet, mixed-mode link
 * modes, the wide lock-in walk (100 nodes / 50 writes), root-churn retention +
 * rematerialization, grown-then-shrunk mark decay, and GEN id-tenancy.
 * Every engine reset here runs with the divergence check armed — each public
 * operation's epilogue serves every live arena's shadows from the arena's
 * own walks and compares against the reference folds; any mismatch (or
 * structural-validator breach) throws. The settlement pins' contract:
 * settlement re-evaluates the consumers that suspended.
 */
import { describe, expect, it } from 'vitest'
import { __TEST__ctxUse, SuspendedRead } from '../src/index.js'
import {
	engine,
	__TEST__resetEngine,
	InvariantViolation,
	type AnyInternals,
	type CosignalEngine,
	type Reader,
	type Value,
} from '../src/CosignalEngine.js'
import { armArenaCheck } from './arena-checker.js'
import { attachRefereeStream, refereeStreamOf } from './trace-events.js'

const tick = (): Promise<void> => new Promise<void>((res) => setTimeout(res, 0))

function freshEngine(): CosignalEngine {
	// Finish the previous test's leftover episode so the reset's idle preconditions hold.
	engine.discardAllWip()
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id)
		else engine.retire(t.id)
	}
	__TEST__resetEngine()
	const b = engine
	attachRefereeStream(b) // the decoded packed stream is the event surface
	armArenaCheck(b)
	return b
}

/** The shim-wrapper analog (`internalsForComputed`'s world fn): a background suspension
 * folds to the thenable's stable sentinel VALUE instead of unwinding. */
function suspending(
	b: CosignalEngine,
	name: string,
	fn: (read: Reader, untracked: Reader) => Value,
): AnyInternals {
	return b.computed(name, (read, untracked) => {
		try {
			return fn(read, untracked)
		} catch (err) {
			if (err instanceof SuspendedRead) return err
			throw err
		}
	})
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

/** A manually-settled thenable whose callbacks fire SYNCHRONOUSLY at
 * settle() — the custom-thenable shape the step-0 pins need. */
function manual<T>(): { t: PromiseLike<T>; settle: (v: T) => void } {
	const cbs: ((v: T) => void)[] = []
	const t: PromiseLike<T> = {
		then(onF): PromiseLike<never> {
			if (onF) cbs.push(onF as (v: T) => void)
			return undefined as never
		},
	} as PromiseLike<T>
	return {
		t,
		settle: (v: T) => {
			for (const cb of cbs) cb(v)
		},
	}
}

/** Mount a live committed watcher on `node` via a clean commit. */
function mount(b: CosignalEngine, root: string, node: AnyInternals, name: string) {
	const p = b.renderStart(root, [])
	const w = b.mountWatcher(p.id, node, name)
	b.renderEnd(p.id, 'commit')
	return w
}

function corrections(b: CosignalEngine, watcher: string): number {
	return refereeStreamOf(b)
		.eventsOfType('reconcile-correction')
		.filter((e) => e.watcher === watcher).length
}

describe('S-A settlement octet (§4.5.4 + step-0 shapes; RCC-SU5)', () => {
	it('at-rest background settlement: the drain itself delivers the correction — NO subsequent operation', async () => {
		const b = freshEngine()
		const gate = deferred<string>()
		const c: AnyInternals = suspending(b, 'c', () => __TEST__ctxUse(c.ix, 'k', () => gate.promise))
		const w = mount(b, 'R', c, 'W')
		expect(w.lastRenderedValue).toBeInstanceOf(SuspendedRead) // sentinel cached (arena box-suspended)
		expect(b.__TEST__arenaStats().suspended).toBe(1)
		gate.resolve('DATA') // fully at rest: no operation open, ever again
		await tick()
		// The settle tap's drain scanned the suspended list, refolded the
		// cone, revalidated, and FLUSHED — the correction arrived from the
		// settlement event itself.
		expect(corrections(b, 'W')).toBe(1)
		expect(w.lastRenderedValue).toBe('DATA')
		expect(b.__TEST__arenaStats().suspended).toBe(0)
		expect(b.committedValue(c, 'R')).toBe('DATA')
	})

	it("mid-operation settlement: the enclosing operation's epilogue fixed point consumes it", async () => {
		const b = freshEngine()
		const m1 = manual<string>()
		const key = b.atom('key', 0)
		const c: AnyInternals = suspending(b, 'c', (read) => {
			read(key)
			return __TEST__ctxUse(c.ix, 'k', () => m1.t)
		})
		const w = mount(b, 'R', c, 'W')
		expect(w.lastRenderedValue).toBeInstanceOf(SuspendedRead)
		// Settle DURING a watcher drain: hook the correction of an unrelated
		// watcher that drains first (id order) — here simpler: settle inside
		// the write operation via an updater is illegal (fold purity), so use
		// onCorrection of a sibling cone.
		const kick = b.atom('kick', 0)
		const d = b.computed('d', (read) => read(kick))
		mount(b, 'R', d, 'WD')
		let settled = false
		b.onCorrection = () => {
			if (!settled) {
				settled = true
				m1.settle('MID') // lands mid-flushNotify → queued → next drain iteration
			}
		}
		const t = b.openBatch()
		b.write(t.id, kick, 0, 1)
		b.retire(t.id) // WD corrects → callback settles m1 mid-flush
		// The SAME operation's epilogue drained the queued settlement:
		expect(settled).toBe(true)
		expect(w.lastRenderedValue).toBe('MID')
		expect(b.__TEST__arenaStats().pendingSettlements).toBe(0)
		expect(b.committedValue(c, 'R')).toBe('MID')
	})

	it('reentrant settle-during-flush (step 0): a correction callback settles another thenable — the NEXT loop iteration delivers it before the drain returns', async () => {
		const b = freshEngine()
		const g1 = deferred<string>()
		const m2 = manual<string>()
		const c1: AnyInternals = suspending(b, 'c1', () =>
			__TEST__ctxUse(c1.ix, 'k1', () => g1.promise),
		)
		const c2: AnyInternals = suspending(b, 'c2', () => __TEST__ctxUse(c2.ix, 'k2', () => m2.t))
		const w1 = mount(b, 'R', c1, 'W1')
		const w2 = mount(b, 'R', c2, 'W2')
		expect(b.__TEST__arenaStats().suspended).toBe(2)
		let reentered = false
		b.onCorrection = (w) => {
			if (w.name === 'W1' && !reentered) {
				reentered = true
				m2.settle('CHAIN') // synchronous settle INSIDE the drain's flushNotify
			}
		}
		g1.resolve('FIRST') // at-rest settlement → drain iteration 1 heals c1
		await tick()
		// Iteration 1's flushNotify ran the W1 correction, whose callback
		// settled thenable → queued → iteration 2 healed c2 and flushed W2's
		// correction — all inside ONE drain, no subsequent operation.
		expect(w1.lastRenderedValue).toBe('FIRST')
		expect(w2.lastRenderedValue).toBe('CHAIN')
		expect(corrections(b, 'W2')).toBe(1)
		expect(b.__TEST__arenaStats().suspended).toBe(0)
		expect(b.__TEST__arenaStats().pendingSettlements).toBe(0)
	})

	it('read-context microtask drain (step 0): a sync thenable settling during standalone committedValue strands nothing — the coalesced queueMicrotask drain consumes it', async () => {
		const b = freshEngine()
		const m1 = manual<string>()
		const c: AnyInternals = suspending(b, 'c', () => __TEST__ctxUse(c.ix, 'k', () => m1.t))
		const w = mount(b, 'R', c, 'W')
		expect(w.lastRenderedValue).toBeInstanceOf(SuspendedRead)
		// Settle synchronously while ONLY a read frame is open: no public
		// operation, hence no epilogue — the tap schedules the microtask.
		const during = b.computed('probe', () => {
			m1.settle('SYNC')
			return 0
		})
		b.committedValue(during, 'R') // read context: evalDepth > 0 at the tap
		expect(b.__TEST__arenaStats().pendingSettlements).toBe(1) // queued, not stranded forever…
		await tick()
		// …the microtask drain consumed it: refire arrived with NO operation.
		expect(b.__TEST__arenaStats().pendingSettlements).toBe(0)
		expect(w.lastRenderedValue).toBe('SYNC')
		expect(corrections(b, 'W')).toBe(1)
	})

	it('read-after-await self-heal (pull half): committedValue observes the settled outcome deterministically, before any drain', async () => {
		const b = freshEngine()
		const gate = deferred<string>()
		const c: AnyInternals = suspending(b, 'c', () => __TEST__ctxUse(c.ix, 'k', () => gate.promise))
		mount(b, 'R', c, 'W')
		expect(b.committedValue(c, 'R')).toBeInstanceOf(SuspendedRead)
		gate.resolve('HEALED')
		await gate.promise // the continuation may run BEFORE the settle listener's microtask
		// The read-site status probe (boxedRead-style) self-heals AT THE READ.
		expect(b.committedValue(c, 'R')).toBe('HEALED')
	})

	it('key-A/key-B world-only settlement: the kernel never cached A; the tap + suspended-list scan still heal the committed world', async () => {
		const b = freshEngine()
		const gateA = deferred<string>()
		const kick = b.atom('kick', 0)
		const c: AnyInternals = suspending(b, 'c', (read) => {
			const key = (read(kick) as number) === 0 ? 'A' : 'B'
			return __TEST__ctxUse(c.ix, key, () =>
				key === 'A'
					? gateA.promise
					: ({
							then: () => undefined as never,
							status: 'fulfilled',
							value: 'B!',
						} as PromiseLike<string>),
			)
		})
		const w = mount(b, 'R', c, 'W') // committed world: key A → suspends, sentinel cached
		expect(w.lastRenderedValue).toBeInstanceOf(SuspendedRead)
		const t = b.openBatch()
		b.write(t.id, kick, 0, 1)
		expect(b.newestValue(c)).toBe('B!') // newest asks key B: pre-settled, no listener needed
		gateA.resolve('A!') // world-only settlement: no kernel cache ever held A
		await tick()
		expect(w.lastRenderedValue).toBe('A!') // healed FROM the settlement drain
		b.retire(t.id)
	})

	it('termination cap (step 0): a self-perpetuating settlement chain trips the dev diagnostic instead of hanging', async () => {
		const b = freshEngine()
		b.__TEST__setSettleCap(8)
		const K = 12 // chain length > cap
		const gates = Array.from({ length: K }, () => manual<string>())
		const watchers = gates.map((g, i) => {
			const c: AnyInternals = suspending(b, `c${i}`, () => __TEST__ctxUse(c.ix, `k${i}`, () => g.t))
			return mount(b, 'R', c, `W${i}`)
		})
		expect(b.__TEST__arenaStats().suspended).toBe(K)
		let chain = 0
		b.onCorrection = () => {
			if (++chain < K) gates[chain]!.settle(`v${chain}`) // each iteration creates the next settlement
		}
		expect(() => gates[0]!.settle('v0')).toThrow(InvariantViolation)
		expect(chain).toBeGreaterThanOrEqual(8) // the loop made real progress up to the cap
		expect(watchers[0]!.lastRenderedValue).toBe('v0')
	})

	it('suspended-list compaction (step 0): clear → re-suspend keeps the list a dense set; swap-remove preserves every stored index', async () => {
		const b = freshEngine()
		const gs = [deferred<string>(), deferred<string>(), deferred<string>()]
		const keyAtom = b.atom('key', 0)
		const cs: AnyInternals[] = gs.map((g, i) =>
			suspending(b, `c${i}`, (read) => {
				const gen = read(keyAtom) as number
				return __TEST__ctxUse(cs[i]!.ix, `k${i}-${gen}`, () =>
					gen === 0 ? g.promise : deferred<string>().promise,
				)
			}),
		)
		for (let i = 0; i < 3; i++) mount(b, 'R', cs[i]!, `W${i}`)
		expect(b.__TEST__arenaStats().suspended).toBe(3)
		gs[1]!.resolve('MID') // clear the MIDDLE entry: swap-remove moves the tail into its slot
		await tick()
		expect(b.__TEST__arenaStats().suspended).toBe(2) // dense; validator checked index integrity at the epilogue
		// Re-suspend all three on fresh keys (new pending thenables):
		const t = b.openBatch()
		b.write(t.id, keyAtom, 0, 1)
		b.retire(t.id)
		expect(b.__TEST__arenaStats().suspended).toBe(3) // exactly one dense entry per shadow — never a duplicate
		expect(b.__TEST__arenaStats().pendingSettlements).toBe(0)
	})
})
