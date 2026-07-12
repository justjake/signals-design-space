/**
 * Leak audit (--expose-gc): explicit disposal releases graph ownership;
 * quiescence leaves no per-suspension state.
 *
 * Reclamation model under test:
 * - Unwatched computeds hold references dependency-ward only, so dropping
 *   the last user reference collects the whole chain structurally.
 * - Effect disposers are FinalizationRegistry-backed: dropping a disposer
 *   without calling it reclaims the watcher and unlinks its subscriptions.
 * - Draft retirement drops rebase logs and world memos (quiescence).
 */
import { describe, expect, test } from 'vitest'
import { createComputed, effect, effectScope, nodeOf, read, createAtom, type Atom } from '../src/index.ts'
import { nextSubscriber, observeNode, type CellNode, type Link } from '../src/graph.ts'
import {
	liveDraftCount,
	openDraft,
	resolveState,
	retireDraft,
	runWithDraftWrites,
	sealDraft,
	worldOf,
	type DraftId,
} from '../src/worlds.ts'

function subCount(x: Atom<number>): number {
	let n = 0
	for (
		let l: Link | undefined = (nodeOf(x) as CellNode<number>).subs;
		l !== undefined;
		l = nextSubscriber(l)
	) {
		n++
	}
	return n
}

async function collect(times = 5): Promise<void> {
	if (typeof gc !== 'function') {
		throw new Error('run with --expose-gc')
	}
	for (let i = 0; i < times; i++) {
		gc()
		await new Promise<void>((r) => setTimeout(() => r(), 10))
	}
}

describe('leak audit', () => {
	test('a dropped unwatched computed chain is collected (no registry needed)', async () => {
		const base = createAtom(1)
		let finalized = false
		const reg = new FinalizationRegistry(() => {
			finalized = true
		})
		;(() => {
			const mid = createComputed(() => base.get() * 2)
			const top = createComputed(() => mid.get() + 1)
			expect(read(top)).toBe(3)
			reg.register(top, null)
		})()
		await collect()
		expect(finalized).toBe(true)
		expect(subCount(base)).toBe(0) // unwatched reads never registered subscriptions
	})

	test('quiescence: retiring the last draft leaves no per-suspension state', () => {
		const a = createAtom(0)
		const c = createComputed(() => a.get() + 1)
		const d1 = openDraft()
		const d2 = openDraft()
		runWithDraftWrites(d1, () => a.set(1))
		runWithDraftWrites(d2, () => a.update((x) => x + 5))
		resolveState(nodeOf(c), worldOf([d1.id]))
		resolveState(nodeOf(c), worldOf([d1.id, d2.id]))
		expect(nodeOf(c).worldMemos).not.toBeNull()
		retireDraft(d1.id)
		expect(nodeOf(c).worldMemos).not.toBeNull() // d2 still live
		retireDraft(d2.id)
		expect(nodeOf(c).worldMemos).toBeNull()
		expect(nodeOf(a).worldMemos).toBeNull()
		expect(liveDraftCount()).toBe(0)
		expect(read(a)).toBe(6)
	})

	test('a retired draft id in long-lived state retains neither the Draft record nor its logged intents', async () => {
		// The React bindings' contract: long-lived React state (reducer worlds,
		// committed id sets) holds draft IDS, never Draft records — a record
		// captured in a committed reducer state that never updates again would
		// be retained forever, while a stale id is inert.
		const a = createAtom({ n: 0 })
		const committedReducerState: DraftId[] = [] // stands in for React state that never updates again
		let draftRef!: WeakRef<object>
		let payloadRef!: WeakRef<object>
		;(() => {
			const draft = openDraft()
			const payload = { n: 1 }
			runWithDraftWrites(draft, () => a.set(payload))
			sealDraft(draft)
			committedReducerState.push(draft.id)
			draftRef = new WeakRef(draft)
			payloadRef = new WeakRef(payload)
			retireDraft(draft.id)
		})()
		expect(read(a).n).toBe(1) // the fold landed the logged payload in base state
		a.set({ n: 2 }) // base state moves on: nothing references the payload
		await collect(10)
		expect(committedReducerState.length).toBe(1) // the id is still held — and inert
		expect(draftRef.deref()).toBeUndefined()
		expect(payloadRef.deref()).toBeUndefined()
	})

	test('promote/demote cycling leaves no back-edges; the demoted chain collects when dropped', async () => {
		const base = createAtom(1)
		let finalized = false
		const reg = new FinalizationRegistry(() => {
			finalized = true
		})
		;(() => {
			const mid = createComputed(() => base.get() * 2)
			const top = createComputed(() => mid.get() + 1)
			// Subscribe without pulling, pull through the watched tier, then
			// unsubscribe: promote installed back-edges down to the cell, and
			// demote must remove every one of them.
			const unsub = observeNode(nodeOf(top), () => {})
			expect(read(top)).toBe(3)
			expect(subCount(base)).toBe(1)
			unsub()
			expect(subCount(base)).toBe(0)
			reg.register(top, null)
		})()
		await collect()
		expect(finalized).toBe(true) // forward references only after demote
		expect(subCount(base)).toBe(0)
	})

	test('disposing an effect deterministically unlinks now (no GC needed)', () => {
		const base = createAtom(1)
		const dispose = effect(() => void base.get())
		expect(subCount(base)).toBe(1)
		dispose()
		expect(subCount(base)).toBe(0)
	})

	test('[guard] a disposed effect collects even though the watcher queue retains capacity', async () => {
		// The flush queues keep their backing stores across waves (logical-length
		// clear, not `.length = 0`). The correctness price is that consumed slots
		// must be nulled at drain: a soft-cleared slot that still held its watcher
		// would pin the disposed watcher (and its closure) forever. Passes before
		// and after the storage change; fails against a retained-capacity variant
		// that skips the nulling.
		const cell = createAtom(0)
		const payloadRef = (() => {
			const payload = { tag: 'effect-closure-payload' }
			const dispose = effect(() => {
				cell.get()
				void payload
			})
			cell.set(1) // flush enqueues and runs the watcher (slot consumed)
			dispose()
			return new WeakRef(payload)
		})()
		await collect(10)
		expect(payloadRef.deref()).toBeUndefined()
	})

	test('[guard] a disposed subscription collects even though the render-notify buffer retains capacity', async () => {
		const cell = createAtom(0)
		const payloadRef = (() => {
			const payload = { tag: 'subscription-closure-payload' }
			const unsub = observeNode(nodeOf(cell), () => void payload)
			cell.set(1) // delivery consumes the subscription's buffer slot
			unsub()
			return new WeakRef(payload)
		})()
		await collect(10)
		expect(payloadRef.deref()).toBeUndefined()
	})

	test('[guard] effects preempted by a throwing flush collect after disposal (catch-path slots nulled)', async () => {
		const cell = createAtom(0)
		let armed = false
		const payloadRef = (() => {
			const disposeThrowing = effect(() => {
				cell.get()
				if (armed) {
					throw new Error('boom')
				}
			})
			// Scheduled behind the thrower: the aborted flush clears it via the
			// catch path, which must null its unconsumed slot too.
			const payload = { tag: 'preempted-effect-payload' }
			const disposePreempted = effect(() => {
				cell.get()
				void payload
			})
			armed = true
			expect(() => cell.set(1)).toThrow('boom')
			disposeThrowing()
			disposePreempted()
			return new WeakRef(payload)
		})()
		armed = false
		await collect(10)
		expect(payloadRef.deref()).toBeUndefined()
	})

	test('a scope owns effects whose individual disposer is unused', () => {
		const base = createAtom(1)
		let runs = 0
		const disposeScope = effectScope(() => {
			// Common usage: the per-effect disposer is dropped because the scope
			// owns the effect. Collecting that disposer is not abandonment — the
			// effect must stay live until the scope goes.
			void effect(() => {
				base.get()
				runs++
			})
		})
		expect(runs).toBe(1)
		base.set(2)
		expect(runs).toBe(2) // still alive: the scope is the owner
		disposeScope()
		base.set(3)
		expect(runs).toBe(2) // scope disposal is the reclamation path
		expect(subCount(base)).toBe(0)
	})
})
