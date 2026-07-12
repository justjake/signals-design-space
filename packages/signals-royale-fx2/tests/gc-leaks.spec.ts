/**
 * Leak audit (--expose-gc): explicit disposal releases graph ownership;
 * quiescence leaves no per-suspension state.
 *
 * Reclamation model under test:
 * - Unwatched computeds hold references dependency-ward only, so dropping
 *   the last user reference collects the whole chain structurally.
 * - Effects and subscriptions are explicit resources; their owners call the
 *   returned disposer.
 * - Draft retirement drops rebase logs and world memos (quiescence).
 */
import { describe, expect, test } from 'vitest'
import {
	createAtom,
	createComputed,
	effect,
	effectScope,
	nodeOf,
	read,
	type Atom,
} from '../src/index.ts'
import { observeNode, type AtomNode, type Link } from '../src/graph.ts'
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
		let l: Link | undefined = (nodeOf(x) as AtomNode<number>).subs;
		l !== undefined;
		l = l.nextSub
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
		expect(nodeOf(c).worldMemos).toBeInstanceOf(Map)
		retireDraft(d1.id)
		expect(nodeOf(c).worldMemos).toBeInstanceOf(Map) // d2 still live
		retireDraft(d2.id)
		expect(nodeOf(c).worldMemos).toBeUndefined()
		expect(nodeOf(a).worldMemos).toBeUndefined()
		expect(liveDraftCount()).toBe(0)
		expect(read(a)).toBe(6)
	})

	test('a retired draft id in long-lived state retains neither the Draft record nor its logged intents', async () => {
		// React bindings promise that long-lived React state (reducer
		// worlds, committed id sets) holds draft ids, never Draft records —
		// a record captured in a committed reducer state that never updates
		// again would be retained forever, while a stale id is inert.
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
			// unsubscribe: promote installed back-edges down to the atom, and
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
		const atom = createAtom(0)
		const payloadRef = (() => {
			const payload = { tag: 'effect-closure-payload' }
			const dispose = effect(() => {
				atom.get()
				void payload
			})
			atom.set(1) // flush enqueues and runs the watcher (slot consumed)
			dispose()
			return new WeakRef(payload)
		})()
		await collect(10)
		expect(payloadRef.deref()).toBeUndefined()
	})

	test('[guard] a disposed subscription collects even though the render-notify buffer retains capacity', async () => {
		const atom = createAtom(0)
		const payloadRef = (() => {
			const payload = { tag: 'subscription-closure-payload' }
			const unsub = observeNode(nodeOf(atom), () => void payload)
			atom.set(1) // delivery consumes the subscription's buffer slot
			unsub()
			return new WeakRef(payload)
		})()
		await collect(10)
		expect(payloadRef.deref()).toBeUndefined()
	})

	test('[guard] deep-chain scratch slots do not retain computed nodes', async () => {
		const base = createAtom(0)
		let savedRef!: WeakRef<object>
		;(() => {
			const nodes = []
			let top = createComputed(() => base.get() + 1)
			nodes.push(top)
			for (let i = 1; i < 40; i++) {
				const previous = top
				top = createComputed(() => previous.get() + 1)
				nodes.push(top)
			}
			const dispose = effect(() => void top.get())
			base.set(1)
			savedRef = new WeakRef(nodeOf(nodes[23]))
			dispose()
		})()
		await collect(10)
		expect(savedRef.deref()).toBeUndefined()
		expect(subCount(base)).toBe(0)
	})

	test('[guard] effects preempted by a throwing flush collect after disposal (catch-path slots nulled)', async () => {
		const atom = createAtom(0)
		let armed = false
		const payloadRef = (() => {
			const disposeThrowing = effect(() => {
				atom.get()
				if (armed) {
					throw new Error('boom')
				}
			})
			// Scheduled behind the thrower: the aborted flush clears it via the
			// catch path, which must null its unconsumed slot too.
			const payload = { tag: 'preempted-effect-payload' }
			const disposePreempted = effect(() => {
				atom.get()
				void payload
			})
			armed = true
			expect(() => atom.set(1)).toThrow('boom')
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
