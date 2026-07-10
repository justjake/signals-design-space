// M3 — the world overlay: visibility (§10.2), world memos + certificates
// (§10.5), the post-eval re-check (§10.4), sweep retention and truncation
// (§9.6), suspense settlement (§12.3), and the T1-T7 world-divergent
// dependency family (§17.4).
import { beforeEach, describe, expect, it } from 'vitest'
import {
	Atom,
	Computed,
	ForkDouble,
	__debug,
	__resetEngineForTests,
	attachFork,
	createWatcher,
	latest,
} from '../src/index'

let fork: ForkDouble

beforeEach(() => {
	__resetEngineForTests()
	fork = new ForkDouble()
	attachFork(fork)
})

describe('visibility truth table (§10.2)', () => {
	it('clause 1: entries retired before the pin are visible even outside the mask', () => {
		const a = new Atom({ state: 0 })
		const k = fork.openBatch(true)
		fork.inBatch(k, () => a.set(1))
		fork.retireBatch(k, true) // retired BEFORE the pass pins
		const u = fork.openBatch(false) // unrelated batch keeps LOGGED mode alive
		fork.inBatch(u, () => new Atom({ state: 0 }).set(1)) // noop-ish
		fork.startRenderPass('root', [u]) // mask excludes k (it is dead anyway)
		expect(a.state).toBe(1) // k's write is committed history
		fork.endRenderPass()
		fork.retireBatch(u, true)
	})

	it('clause 1 pin: a retirement during a yielded pass stays invisible to it', () => {
		const a = new Atom({ state: 0 })
		const k = fork.openBatch(true)
		const other = fork.openBatch(true)
		fork.inBatch(k, () => a.set(1))
		fork.startRenderPass('root', [other]) // pass excludes k, pins now
		expect(a.state).toBe(0)
		fork.yieldPass()
		fork.retireBatch(k, true) // another root commits while we are paused
		expect(__debug.kernelValue(a)).toBe(1) // canonical moved
		fork.resumePass()
		expect(a.state).toBe(0) // the pass keeps reading what it started with
		fork.endRenderPass()
		fork.retireBatch(other, false)
		expect(a.state).toBe(1)
	})

	it('clause 2: included batches show writes that predate the pin, hide later ones', () => {
		const a = new Atom({ state: 0 })
		const k = fork.openBatch(true)
		fork.inBatch(k, () => a.set(1))
		fork.startRenderPass('root', [k])
		expect(a.state).toBe(1) // included + seq <= pin
		fork.yieldPass()
		fork.inBatch(k, () => a.set(2)) // arrives during the render
		fork.resumePass()
		expect(a.state).toBe(1) // hidden from this pass, like React's queues
		fork.endRenderPass()
		// Ambient-W0: the pending draft stays invisible; latest() is the Wn read.
		expect(a.state).toBe(0)
		expect(latest(a)).toBe(2)
		fork.retireBatch(k, true)
		expect(a.state).toBe(2)
	})

	it('COMMITTED excludes applied-but-pending entries; NEWEST sees everything', () => {
		const a = new Atom({ state: 0 })
		const u = fork.openBatch(false)
		const k = fork.openBatch(true)
		fork.inBatch(u, () => a.set(1)) // urgent: applied, unretired
		fork.inBatch(k, () => a.set(2)) // deferred: unapplied
		expect(a.state).toBe(1) // ambient = W0: urgent applied, draft hidden
		expect(latest(a)).toBe(2) // Wn: everything
		expect(__debug.committed(() => a.state)).toBe(0) // neither retired
		expect(__debug.kernelValue(a)).toBe(1) // W0 = applied only
		fork.retireBatch(u, true)
		expect(__debug.committed(() => a.state)).toBe(1)
		fork.retireBatch(k, true)
		expect(__debug.committed(() => a.state)).toBe(2)
	})
})

describe('world memos and certificates (§10.5)', () => {
	it('a hot writer-world read loop evaluates once (memo hit)', () => {
		const a = new Atom({ state: 0 })
		let runs = 0
		const c = new Computed({
			fn: () => {
				++runs
				return a.state + 1
			},
		})
		expect(c.state).toBe(1)
		const k = fork.openBatch(true)
		fork.inBatch(k, () => a.set(5))
		runs = 0
		for (let i = 0; i < 10; ++i) {
			expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(6)
		}
		expect(runs).toBe(1)
		fork.retireBatch(k, true)
	})

	it('an append to a read source invalidates via the tail-seq pair', () => {
		const a = new Atom({ state: 0 })
		let runs = 0
		const c = new Computed({
			fn: () => {
				++runs
				return a.state + 1
			},
		})
		expect(c.state).toBe(1)
		const k = fork.openBatch(true)
		fork.inBatch(k, () => a.set(5))
		expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(6)
		fork.startRenderPass('root', []) // an open pass blocks coalescing
		fork.endRenderPass()
		fork.inBatch(k, () => a.set(7)) // append (not coalesce)
		expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(8)
		fork.retireBatch(k, true)
	})

	it('coalescing rewrites the tail seq and invalidates the memo', () => {
		const a = new Atom({ state: 0 })
		const c = new Computed({ fn: () => a.state + 1 })
		expect(c.state).toBe(1)
		const k = fork.openBatch(true)
		fork.inBatch(k, () => a.set(5))
		expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(6)
		fork.inBatch(k, () => a.set(9)) // coalesced in place, fresh seq
		expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(10)
		fork.retireBatch(k, true)
	})

	it("another batch's retirement bumps the epoch and re-validates conservatively", () => {
		const a = new Atom({ state: 0 })
		const b = new Atom({ state: 0 })
		const c = new Computed({ fn: () => a.state + b.state })
		expect(c.state).toBe(0)
		const k1 = fork.openBatch(true)
		const k2 = fork.openBatch(true)
		fork.inBatch(k1, () => a.set(1))
		fork.inBatch(k2, () => b.set(10))
		expect(__debug.readInWorld(c, { kind: 'writer', token: k1 })).toBe(1)
		expect(__debug.readInWorld(c, { kind: 'writer', token: k2 })).toBe(10)
		fork.retireBatch(k2, true) // k2's entries become visible in k1's world
		expect(__debug.readInWorld(c, { kind: 'writer', token: k1 })).toBe(11)
		fork.retireBatch(k1, true)
		expect(c.state).toBe(11)
	})

	it('nested evaluation flattens certificates: grandchild sources invalidate the parent', () => {
		const flag = new Atom({ state: false })
		const a = new Atom({ state: 0 })
		const mid = new Computed({ fn: () => a.state + 1 })
		const top = new Computed({ fn: () => (flag.state ? mid.state : -1) })
		expect(top.state).toBe(-1) // canonical: never reads mid or a
		const k = fork.openBatch(true)
		fork.inBatch(k, () => flag.set(true))
		// Seed the child memo first so the parent's evaluation HITS it and must
		// copy its certificate run (the memo-hit flattening path).
		expect(__debug.readInWorld(mid, { kind: 'writer', token: k })).toBe(1)
		expect(__debug.readInWorld(top, { kind: 'writer', token: k })).toBe(1)
		// Grandchild source write: `a` was unlogged when read (zero pair).
		fork.inBatch(k, () => a.set(41))
		expect(__debug.readInWorld(top, { kind: 'writer', token: k })).toBe(42)
		expect(__debug.committed(() => top.state)).toBe(-1)
		fork.retireBatch(k, true)
		expect(top.state).toBe(42)
	})
})

describe('post-eval re-check (§10.4)', () => {
	it('a fresh computed created mid-era answers world-sensitive readers correctly', () => {
		const a = new Atom({ state: 0 })
		const k = fork.openBatch(true)
		fork.inBatch(k, () => a.set(1))
		// Created AFTER the write: no walk ever visited it; stamp is unmarked.
		const c2 = new Computed({ fn: () => a.state * 2 })
		// The kernel path would canonically evaluate (W0: a=0 → 0); the
		// mark-repair in linkInsert plus the post-eval re-check must redirect
		// world-sensitive readers to the overlay.
		expect(__debug.readInWorld(c2, { kind: 'writer', token: k })).toBe(2)
		expect(__debug.committed(() => c2.state)).toBe(0)
		fork.retireBatch(k, true)
		expect(c2.state).toBe(2)
	})

	it('an old computed taking a new branch into a logged atom mid-era re-checks', () => {
		const sel = new Atom({ state: false })
		const a = new Atom({ state: 0 })
		const b = new Atom({ state: 100 })
		const c = new Computed({ fn: () => (sel.state ? a.state : b.state) })
		expect(c.state).toBe(100) // canonical deps: sel, b
		const k = fork.openBatch(true)
		fork.inBatch(k, () => a.set(7)) // a logged; c's cone NOT marked (no edge)
		const u = fork.openBatch(false)
		fork.inBatch(u, () => sel.set(true)) // urgent: canonical re-eval takes the new branch
		// Canonical value now reads a (W0: a's deferred write is unapplied → 0).
		// Committed world excludes both pending writes: sel=false → b → 100.
		expect(__debug.committed(() => c.state)).toBe(100)
		expect(__debug.kernelValue(a)).toBe(0) // deferred write is log-only
		// Newest is the world-sensitive read the post-eval re-check protects:
		// the canonical re-evaluation linked c→a (marking c via repair), and the
		// newest world must fold a's pending 7 — not serve the W0 cache (0).
		// Ambient is W0 now, so the Wn observable is latest().
		expect(c.state).toBe(0) // ambient W0: a's draft invisible
		expect(latest(c)).toBe(7) // Wn folds a's pending 7
		fork.retireBatch(u, true)
		fork.retireBatch(k, true)
		expect(c.state).toBe(7)
	})
})

describe('sweep retention and truncation (§9.6)', () => {
	it('a pass pinned across two retirements retains the entries it needs', () => {
		const a = new Atom({ state: 0 })
		const k1 = fork.openBatch(true)
		const k2 = fork.openBatch(true)
		const other = fork.openBatch(true)
		fork.inBatch(k1, () => a.set(1))
		fork.startRenderPass('root', [other]) // pins before the retirements
		expect(a.state).toBe(0)
		fork.yieldPass()
		fork.inBatch(k2, () => a.set(2))
		fork.retireBatch(k1, true)
		fork.retireBatch(k2, true)
		fork.resumePass()
		expect(a.state).toBe(0) // both retirements postdate the pin
		expect(__debug.stats().loggedAtomCount).toBe(1) // tape retained
		fork.endRenderPass()
		expect(a.state).toBe(2)
		fork.retireBatch(other, false)
		expect(__debug.stats().loggedAtomCount).toBe(0) // swept at quiescence
		__debug.verify()
	})

	it('truncation abandons a batch without folding; nothing to un-propagate', () => {
		const a = new Atom({ state: 0 })
		const c = new Computed({ fn: () => a.state + 1 })
		expect(c.state).toBe(1)
		const k = fork.openBatch(true)
		const keep = fork.openBatch(true)
		fork.inBatch(k, () => a.set(100))
		fork.inBatch(keep, () => a.set(5))
		expect(latest(a)).toBe(5) // Wn: both drafts, last-seq wins
		expect(a.state).toBe(0) // ambient W0: drafts hidden
		__debug.truncateToken(k) // optimistic rollback of k only
		expect(latest(a)).toBe(5)
		expect(__debug.readInWorld(a, { kind: 'writer', token: k })).toBe(0) // k's write is gone
		fork.retireBatch(keep, true)
		fork.retireBatch(k, true)
		expect(a.state).toBe(5)
		expect(c.state).toBe(6)
		__debug.verify()
	})
})

describe('ambient-W0 semantics (SPEC-RESOLUTIONS §ambient-W0)', () => {
	it('speculation leak: an urgent write derived from .state during a pending transition uses W0; abort leaves no contamination', () => {
		const a = new Atom({ state: 0 })
		const b = new Atom({ state: 0 })
		const k = fork.openBatch(true)
		fork.inBatch(k, () => a.set(1)) // the pending transition's draft
		// Urgent handler derives from an ambient read: sees W0 (0), NOT the
		// draft — speculation cannot leak into committed state.
		const u = fork.openBatch(false)
		fork.inBatch(u, () => {
			b.set(a.state * 2) // a.state = 0 here (urgent scope ≡ W0)
		})
		fork.retireBatch(u, true)
		expect(b.state).toBe(0)
		expect(latest(a)).toBe(1) // the draft exists — but only Wn shows it
		// Abort the transition by truncation: nothing to un-propagate — the
		// draft never reached any ambient-visible state.
		__debug.truncateToken(k)
		fork.retireBatch(k, false)
		expect(a.state).toBe(0)
		expect(b.state).toBe(0)
		expect(latest(a)).toBe(0)
		__debug.verify()
	})

	it('read-your-own-draft: inside a deferred batch scope, ambient reads resolve that batch world', () => {
		const a = new Atom({ state: 0 })
		const c = new Computed({ fn: () => a.state * 10 })
		expect(c.state).toBe(0)
		const k = fork.openBatch(true)
		fork.inBatch(k, () => {
			a.set(3)
			expect(a.state).toBe(3) // own draft visible in-scope
			expect(c.state).toBe(30) // derived through the draft world
		})
		expect(a.state).toBe(0) // outside the scope: W0, draft hidden
		expect(c.state).toBe(0)
		// Urgent scopes read W0 (their writes are applied, not drafts).
		const u = fork.openBatch(false)
		fork.inBatch(u, () => {
			expect(a.state).toBe(0)
			a.set(7)
			expect(a.state).toBe(7) // applied immediately: W0 includes it
		})
		fork.retireBatch(u, true)
		fork.retireBatch(k, true)
		expect(a.state).toBe(7) // seq order: k's set(3) then u's set(7) — last wins
		__debug.verify()
	})
})

describe('suspense (§12.3, minimal for T7)', () => {
	it('canonical suspension caches a box, settles, and re-evaluates', async () => {
		let resolveIt!: (v: number) => void
		const p = new Promise<number>((res) => {
			resolveIt = res
		})
		const c = new Computed<number>({ fn: (ctx) => ctx.use(p) * 2 })
		expect(() => c.state).toThrow() // throws the thenable while pending
		resolveIt(21)
		await p
		await Promise.resolve() // settlement microtask
		expect(c.state).toBe(42)
	})

	it('T7 view-set divergence: one world suspends, the other reads a value', async () => {
		let resolveIt!: (v: number) => void
		const p = new Promise<number>((res) => {
			resolveIt = res
		})
		const useAsync = new Atom({ state: false })
		const base = new Atom({ state: 1 })
		const c = new Computed<number>({
			fn: (ctx) => (useAsync.state ? ctx.use(p) : base.state),
		})
		expect(c.state).toBe(1)
		const k = fork.openBatch(true) // the suspending batch
		const u = fork.openBatch(true) // the batch that commits alone
		fork.inBatch(k, () => useAsync.set(true))
		fork.inBatch(u, () => base.set(3))
		// Multi-bit mask (k + u): k's world suspends.
		fork.startRenderPass('root', [k, u])
		expect(() => c.state).toThrow()
		fork.endRenderPass()
		// Single-bit mask (u alone): commits without k, no suspension.
		fork.startRenderPass('root', [u])
		expect(c.state).toBe(3)
		fork.endRenderPass()
		fork.retireBatch(u, true)
		expect(__debug.committed(() => c.state)).toBe(3)
		// Settle while k is still pending: epoch bump invalidates the
		// suspended writer's-world memo; k's world now reads the value.
		resolveIt(9)
		await p
		await Promise.resolve()
		expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(9)
		fork.retireBatch(k, true)
		expect(c.state).toBe(9)
	})
})

describe('world-divergent dependencies (§17.4)', () => {
	function divergentSetup() {
		const flag = new Atom({ state: false })
		const a = new Atom({ state: 0 })
		const b = new Atom({ state: 0 })
		const c = new Computed({ fn: () => (flag.state ? a.state : b.state) })
		expect(c.state).toBe(0) // canonical evaluation: reads flag, b
		const notifications: number[] = []
		const watcher = createWatcher(c, (token) => notifications.push(token))
		const k = fork.openBatch(true)
		fork.inBatch(k, () => flag.set(true)) // divergence: k's world reads a
		return { flag, a, b, c, k, notifications, watcher }
	}

	it('T1: the core tear test — three mechanisms fire on the same-batch follow-up write', () => {
		const { a, c, k, notifications } = divergentSetup()
		// The flag-write drain evaluated c in k's world (0, cutoff-suppressed)
		// and registered the memo — with (a, 0) in its certificate — on k's
		// slot chain.
		expect(notifications).toEqual([])
		fork.inBatch(k, () => a.set(1)) // a was UNLOGGED at the memo's read
		// 1. the k-world read returns 1 (certificate zero-pair invalidation):
		expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(1)
		// 2. the watcher was notified in k's lane — reachable only through the
		//    slot-chain re-validation (a has no canonical subscribers):
		expect(notifications).toEqual([k])
		expect(fork.entangleLog.filter((e) => e.ran && e.token === k).length).toBeGreaterThan(0)
		// 3. the committed world still reads 0 via b:
		expect(__debug.committed(() => c.state)).toBe(0)
		fork.retireBatch(k, true)
		expect(c.state).toBe(1)
	})

	it('T2: a k-write to the committed-only dep does not tear either world', () => {
		const { b, c, k, notifications } = divergentSetup()
		fork.inBatch(k, () => b.set(5)) // k's world reads a, not b
		expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(0)
		expect(__debug.committed(() => c.state)).toBe(0)
		expect(notifications).toEqual([]) // no broadcast past the cutoff
		fork.retireBatch(k, true)
		// After k commits: flag=true, a=0, b=5 → c reads a → 0.
		expect(c.state).toBe(0)
	})

	it('T3: a k-write to the shared dep re-evaluates down the other branch, cutoff applies', () => {
		const { flag, c, k, notifications } = divergentSetup()
		// Write the shared dep in k: flip the branch back. k's world now reads
		// b (=0); the k memo invalidates via flag's moved tail seq.
		fork.inBatch(k, () => flag.set(false))
		expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(0)
		// Value unchanged (0 → 0): the equality cutoff suppresses the broadcast.
		expect(notifications).toEqual([])
		expect(__debug.committed(() => c.state)).toBe(0)
		fork.retireBatch(k, true)
		expect(c.state).toBe(0)
		__debug.verify()
	})

	it('T4: an urgent write to the committed-only dep re-renders urgently; k unchanged', () => {
		const { b, c, k, notifications } = divergentSetup()
		const u = fork.openBatch(false)
		fork.inBatch(u, () => b.set(7)) // urgent: applied
		// W0 (canonical): flag=false → b=7; the urgent broadcast fired.
		expect(__debug.kernelValue(b)).toBe(7)
		expect(notifications).toContain(0)
		// k's world reads a, not b: still 0 (may validly re-evaluate; must be 0).
		expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(0)
		fork.retireBatch(u, true)
		expect(__debug.committed(() => c.state)).toBe(7) // committed: flag=false → b
		fork.retireBatch(k, true)
		// After k commits too: flag=true → a=0.
		expect(c.state).toBe(0)
	})

	it('T5: an urgent write to the pending-only dep reaches k through its own world', () => {
		const { a, c, k, notifications } = divergentSetup()
		const u = fork.openBatch(false)
		fork.inBatch(u, () => a.set(9)) // urgent; a had NO canonical subscribers
		// k's world includes applied urgent entries: flag=true → a=9.
		expect(__debug.readInWorld(c, { kind: 'writer', token: k })).toBe(9)
		// The watcher heard about it in k's lane (slot-chain on the urgent drain):
		expect(notifications).toEqual([k])
		// Committed unchanged, no committed broadcast (equality cutoff):
		expect(__debug.committed(() => c.state)).toBe(0)
		expect(notifications).not.toContain(0)
		fork.retireBatch(u, true)
		fork.retireBatch(k, true)
		expect(c.state).toBe(9)
	})

	it('T6: retire/reuse hygiene — a recycled slot answers with fresh bookkeeping', () => {
		const { a, c, k } = divergentSetup()
		fork.inBatch(k, () => a.set(1))
		fork.retireBatch(k, true)
		expect(c.state).toBe(1) // committed: flag=true, a=1
		// k2 likely reuses k's slot; flip polarity: k2 sets flag=false → b branch.
		const k2 = fork.openBatch(true)
		const flagRef = new Atom({ state: 0 }) // noise to shift seqs
		fork.inBatch(k2, () => flagRef.set(1))
		fork.inBatch(k2, () => a.set(50)) // k2 world: flag still true → a=50
		expect(__debug.readInWorld(c, { kind: 'writer', token: k2 })).toBe(50)
		expect(__debug.committed(() => c.state)).toBe(1)
		fork.retireBatch(k2, true)
		expect(c.state).toBe(50)
		__debug.verify()
	})
})
