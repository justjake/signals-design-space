import { describe, expect, it } from 'vitest'
import { createForkDouble, type ExternalRuntimeListener } from '../src/fork-double'

function recordingListener(events: string[]): ExternalRuntimeListener {
	return {
		onRootRegistered: (c) => events.push(`root:${String(c)}`),
		onBatchOpened: (t, d) => events.push(`opened:${t}:${d ? 'deferred' : 'urgent'}`),
		onRenderPassStart: (c, inc, lineage) =>
			events.push(`start:${String(c)}:[${inc.join(',')}]:L${lineage}`),
		onRenderPassEnd: (c) => events.push(`end:${String(c)}`),
		onRenderPassYield: (c) => events.push(`yield:${String(c)}`),
		onRenderPassResume: (c) => events.push(`resume:${String(c)}`),
		onBatchCommitted: (c, t) => events.push(`committed:${String(c)}:${t}`),
		onBatchRetired: (t, committed) => events.push(`retired:${t}:${committed}`),
		onBeforeMutation: (c) => events.push(`beforeMut:${String(c)}`),
		onAfterMutation: (c) => events.push(`afterMut:${String(c)}`),
	}
}

describe('M0 fork double: roots and activation edge', () => {
	it('fires onRootRegistered once per root, rejects duplicates', () => {
		const fork = createForkDouble()
		const events: string[] = []
		fork.subscribeToExternalRuntime(recordingListener(events))
		fork.registerRoot('rootA')
		fork.registerRoot('rootB')
		expect(events).toEqual(['root:rootA', 'root:rootB'])
		expect(() => fork.registerRoot('rootA')).toThrow(/twice/)
	})

	it('unsubscribe stops delivery', () => {
		const fork = createForkDouble()
		const events: string[] = []
		const unsub = fork.subscribeToExternalRuntime(recordingListener(events))
		fork.registerRoot('r')
		unsub()
		fork.openBatch('deferred').token
		expect(events).toEqual(['root:r'])
	})
})

describe('M0 fork double: batch tokens (§6.2)', () => {
	it('mints lazily with deferred bit encoding, fires onBatchOpened at mint', () => {
		const fork = createForkDouble()
		const events: string[] = []
		fork.subscribeToExternalRuntime(recordingListener(events))
		const d = fork.openBatch('deferred')
		const u = fork.openBatch('urgent')
		expect(events).toEqual([]) // claim ≠ mint: no token yet
		expect(d.minted).toBe(false)
		const dt = d.token
		const ut = u.token
		expect(dt & 1).toBe(1)
		expect(ut & 1).toBe(0)
		expect(dt >> 1).toBe(1) // serials from 1
		expect(ut >> 1).toBe(2)
		expect(events).toEqual([`opened:${dt}:deferred`, `opened:${ut}:urgent`])
	})

	it('classifies writes by scope; bare writes mint an urgent event batch', () => {
		const fork = createForkDouble()
		const d = fork.openBatch('deferred')
		expect(fork.isCurrentWriteDeferred()).toBe(false)
		let inScope: boolean | undefined
		let scopeToken: number | undefined
		d.run(() => {
			inScope = fork.isCurrentWriteDeferred()
			scopeToken = fork.getCurrentWriteBatch()
		})
		expect(inScope).toBe(true)
		expect(scopeToken).toBe(d.token)
		// bare write context: urgent event batch, stable across asks
		const t1 = fork.getCurrentWriteBatch()
		const t2 = fork.getCurrentWriteBatch()
		expect(t1).toBe(t2)
		expect(t1 & 1).toBe(0)
		expect(fork.currentEventBatch()?.token).toBe(t1)
		fork.closeEvent()
		const t3 = fork.getCurrentWriteBatch()
		expect(t3).not.toBe(t1) // new event batch after close
	})

	it('enforces the ≤31 live tokens invariant', () => {
		const fork = createForkDouble()
		for (let i = 0; i < 31; i++) {
			fork.openBatch('deferred').token
		}
		expect(fork.liveTokens().length).toBe(31)
		expect(() => fork.openBatch('deferred').token).toThrow(/31 live tokens/)
	})

	it('retires exactly once; committed=false for workless batches by default', () => {
		const fork = createForkDouble()
		const events: string[] = []
		fork.subscribeToExternalRuntime(recordingListener(events))
		const b = fork.openBatch('deferred')
		const t = b.token
		b.retire()
		expect(events).toContain(`retired:${t}:false`)
		expect(() => b.retire()).toThrow(/twice/)
	})
})

describe('M0 fork double: render passes, yields, lineage (§6.3)', () => {
	it('delivers start/yield/resume/end with strict pairing', () => {
		const fork = createForkDouble()
		const events: string[] = []
		fork.subscribeToExternalRuntime(recordingListener(events))
		fork.registerRoot('r')
		const b = fork.openBatch('deferred')
		const t = b.token
		const pass = fork.startPass('r', { include: [b] })
		expect(fork.getRenderContext()).toEqual({ container: 'r' })
		pass.yield()
		expect(fork.getRenderContext()).toBeUndefined() // yield gap: not render
		expect(() => pass.yield()).toThrow(/non-executing/)
		pass.resume()
		expect(fork.getRenderContext()).toEqual({ container: 'r' })
		expect(() => pass.resume()).toThrow(/non-yielded/)
		pass.end()
		expect(fork.getRenderContext()).toBeUndefined()
		expect(() => pass.end()).toThrow(/twice/)
		expect(events).toEqual([
			'root:r',
			`opened:${t}:deferred`,
			`start:r:[${t}]:L1`,
			'yield:r',
			'resume:r',
			'end:r',
		])
	})

	it('one pass at a time; restart reuses lineage and may see new includes', () => {
		const fork = createForkDouble()
		const events: string[] = []
		fork.subscribeToExternalRuntime(recordingListener(events))
		fork.registerRoot('r')
		const b1 = fork.openBatch('deferred')
		const b2 = fork.openBatch('deferred')
		const p1 = fork.startPass('r', { include: [b1] })
		expect(() => fork.startPass('r')).toThrow(/already open/)
		const p2 = p1.restart([b1, b2])
		expect(p2.lineage).toBe(p1.lineage) // same work, same lineage
		expect(p2.includedBatches).toEqual([b1.token, b2.token])
		p2.end()
		const p3 = fork.startPass('r')
		expect(p3.lineage).not.toBe(p1.lineage) // new work, new lineage
		p3.end()
	})

	it('refuses to retire a batch included in the open pass', () => {
		const fork = createForkDouble()
		fork.registerRoot('r')
		const b = fork.openBatch('deferred')
		const pass = fork.startPass('r', { include: [b] })
		expect(() => b.retire()).toThrow(/open pass/)
		pass.end()
		b.retire()
	})
})

describe('M0 fork double: per-root commits and lock-in (§6.1/§6.2)', () => {
	it('fires onBatchCommitted exactly once per (token, root), before retirement', () => {
		const fork = createForkDouble()
		const events: string[] = []
		fork.subscribeToExternalRuntime(recordingListener(events))
		fork.registerRoot('A')
		fork.registerRoot('B')
		const b = fork.openBatch('deferred')
		const t = b.token
		b.commitOnRoot('A')
		expect(() => b.commitOnRoot('A')).toThrow(/duplicate/)
		b.commitOnRoot('B')
		b.retire()
		expect(events.filter((e) => e.startsWith('committed'))).toEqual([
			`committed:A:${t}`,
			`committed:B:${t}`,
		])
		expect(events[events.length - 1]).toBe(`retired:${t}:true`) // committed work
	})

	it('locks committed-elsewhere batches into later passes on that root', () => {
		const fork = createForkDouble()
		fork.registerRoot('A')
		fork.registerRoot('B')
		const b = fork.openBatch('deferred')
		b.commitOnRoot('A') // pending on B, committed on A
		const pass = fork.startPass('A') // no explicit includes
		expect(pass.includedBatches).toContain(b.token) // §6.2 lock-in
		pass.end()
	})
})

describe('M0 fork double: batch entanglement (§6.5)', () => {
	it('runs fn in the batch context while live, returns false when retired', () => {
		const fork = createForkDouble()
		const b = fork.openBatch('deferred')
		const t = b.token
		let sawToken = 0
		let sawDeferred = false
		const ok = fork.runInBatch(t, () => {
			sawToken = fork.getCurrentWriteBatch()
			sawDeferred = fork.isCurrentWriteDeferred()
		})
		expect(ok).toBe(true)
		expect(sawToken).toBe(t)
		expect(sawDeferred).toBe(true)
		b.retire()
		let ran = false
		expect(fork.runInBatch(t, () => (ran = true))).toBe(false)
		expect(ran).toBe(false)
	})

	it('nesting uses the innermost override', () => {
		const fork = createForkDouble()
		const outer = fork.openBatch('deferred')
		const inner = fork.openBatch('urgent')
		let seen: number[] = []
		fork.runInBatch(outer.token, () => {
			seen.push(fork.getCurrentWriteBatch())
			fork.runInBatch(inner.token, () => {
				seen.push(fork.getCurrentWriteBatch())
			})
			seen.push(fork.getCurrentWriteBatch())
		})
		expect(seen).toEqual([outer.token, inner.token, outer.token])
	})
})

describe('M0 fork double: mutation window and error isolation', () => {
	it('brackets mutations', () => {
		const fork = createForkDouble()
		const events: string[] = []
		fork.subscribeToExternalRuntime(recordingListener(events))
		fork.registerRoot('r')
		fork.mutationWindow('r', () => events.push('mutating'))
		expect(events).toEqual(['root:r', 'beforeMut:r', 'mutating', 'afterMut:r'])
	})

	it('captures listener errors instead of throwing them into the caller', () => {
		const fork = createForkDouble()
		fork.subscribeToExternalRuntime({
			onRootRegistered: () => {
				throw new Error('listener boom')
			},
		})
		expect(() => fork.registerRoot('r')).not.toThrow()
		expect(fork.reportedErrors).toHaveLength(1)
		expect(String(fork.reportedErrors[0])).toMatch(/listener boom/)
	})
})
