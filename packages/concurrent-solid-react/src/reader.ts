/**
 * The read side of the React bridge.
 *
 * React renders pull values out of the Solid graph; nothing in the graph may
 * be mutated persistently by a render, because React can discard any render
 * pass. Reads therefore happen in two phases:
 *
 * 1. Render: `renderRead` runs the selector inside a Solid tracking frame
 *    against a shared PROBE node. The probe collects dependency links exactly
 *    like a recompute would (so lazy memos initialize, dirty memos refresh,
 *    pending sources throw), then the links are harvested into a plain array
 *    and immediately removed — a discarded render leaves zero residue.
 *
 * 2. Commit: `syncReaderDeps` links the component's persistent READER node to
 *    the harvested deps. The reader is shaped like a Solid tracked effect
 *    (EFFECT_TRACKED) so every propagation path — insertSubs, notifyStatus,
 *    settle re-runs — delivers a wake-up through `_run`/`_notifyStatus`
 *    instead of recomputing it; the wake-up schedules a React re-render.
 */
import {
	EFFECT_TRACKED,
	NOT_PENDING,
	REACTIVE_OPTIMISTIC_DIRTY,
	REACTIVE_RECOMPUTING_DEPS,
} from './solid/constants.js'
import { runTracked } from './solid/core.js'
import { deferUnobserved, link, unlinkSubs } from './solid/graph.js'
import { dispose } from './solid/owner.js'
import type { IQueue, QueueCallback } from './solid/scheduler.js'
import type { Computed, Link, Signal } from './solid/types.js'

export type DepNode = Signal<any> | Computed<any>

/** An IQueue that invokes wake-ups immediately in the caller's stack, so a
 * reader's React setState inherits the writer's priority/batch context. */
const immediateQueue: IQueue = {
	enqueue(_type: number, fn: QueueCallback): void {
		fn(0)
	},
	run() {},
	addChild() {},
	removeChild() {},
	created: 0,
	notify() {
		return false
	},
	stashQueues() {},
	restoreQueues() {},
	_parent: null,
}

function bareNode(name: string): Computed<any> {
	// A minimal Computed-shaped node. It is never recomputed by the scheduler:
	// EFFECT_TRACKED nodes bypass the dirty heap (insertSubs enqueues `_run`
	// on `_queue` instead), and the no-op `_fn` is a safety net for any
	// recompute reached through untraveled paths.
	const node = {
		_config: 0,
		_equals: false,
		_disposal: null,
		_queue: immediateQueue,
		_context: {},
		_childCount: 0,
		_fn: () => undefined,
		_value: undefined,
		_height: 0,
		_child: null,
		_nextHeap: undefined,
		_prevHeap: null as any,
		_deps: null,
		_depsTail: null,
		_subs: null,
		_subsTail: null,
		_parent: null,
		_nextSibling: null,
		_prevSibling: null,
		_firstChild: null,
		_flags: 0,
		_statusFlags: 0,
		_time: 0,
		_pendingValue: NOT_PENDING,
		_pendingDisposal: null,
		_pendingFirstChild: null,
		_inFlight: null,
		_transition: null,
	} as unknown as Computed<any>
	node._prevHeap = node
	if (__DEV__) {
		;(node as any)._name = name
	}
	return node
}

// Shared probe for render-phase reads. Only one render read is in flight at a
// time on a JS thread, and frames save/restore, so a single node suffices.
const PROBE = bareNode('react-render-probe')
// [react-adapt E13] reads observed through the probe go through the bridge's
// per-render-pass value pinning (tearing prevention for time-sliced passes).
;(PROBE as any)._isRenderProbe = true

/**
 * Run `fn` in a tracking frame against the probe; return its result plus the
 * dependency nodes it read. All probe links are removed before returning —
 * without triggering unobserved/auto-dispose teardown, since a commit will
 * usually re-link the same deps to the component's reader moments later.
 */
export function probeRead<T>(fn: () => T): { value: T; deps: DepNode[] } {
	PROBE._deps = null
	PROBE._depsTail = null
	// The probe reads like a mid-recompute node: REACTIVE_RECOMPUTING_DEPS
	// makes every heap-insertion path (insertIntoHeap / insertIntoHeapHeight)
	// skip it, so graph work triggered inside the frame — a pull-recompute of
	// a dirty memo, a height adjustment — can never park the probe in the
	// dirty heap. A parked probe is fatal: the next frame's flag reset would
	// defeat deleteFromHeap's guard and runHeap would spin on that level
	// forever (the "urgent write wedges the page" lockup class).
	PROBE._flags = REACTIVE_RECOMPUTING_DEPS
	// Scrub state that propagation may have stamped on the probe while it was
	// transiently linked in an earlier frame (status walks, world stamps).
	PROBE._statusFlags = 0
	PROBE._error = undefined
	PROBE._pendingSource = undefined
	PROBE._pendingSources = undefined
	PROBE._transition = null
	PROBE._reentryWorld = undefined
	try {
		const value = runTracked(PROBE, fn)
		return { value, deps: harvestProbe() }
	} catch (e) {
		// Preserve the deps read before the throw (a pending read mid-selector):
		// the commit still subscribes to them so settlement re-renders the host.
		;(e as any).__csrDeps = harvestProbe()
		throw e
	} finally {
		PROBE._flags = 0
	}
}

function harvestProbe(): DepNode[] {
	const deps: DepNode[] = []
	for (let l = PROBE._deps; l !== null; l = l._nextDep) {
		deps.push(l._dep)
	}
	// Unlink dep-side only; the probe's own list is reset on next use. No
	// teardown reaction: render reads must never dispose graph nodes.
	for (let l = PROBE._deps; l !== null; l = l._nextDep) {
		const dep = l._dep
		const nextSub = l._nextSub
		const prevSub = l._prevSub
		if (nextSub !== null) {
			nextSub._prevSub = prevSub
		} else {
			dep._subsTail = prevSub
		}
		if (prevSub !== null) {
			prevSub._nextSub = nextSub
		} else {
			dep._subs = nextSub
		}
	}
	PROBE._deps = null
	PROBE._depsTail = null
	return deps
}

export interface ReaderNode extends Computed<any> {
	_type: number
	_modified: boolean
	_run: () => void
	_isReactReader: true
}

/**
 * Wake every React reader in `el`'s transitive subscriber cone, immediately.
 * Used for deferred (transition) writes: React retires a batch that never
 * scheduled React work at the end of the event's scheduling microtask, so a
 * store-only startTransition would evaporate before Solid's flush propagates
 * dirtiness through memos to the component readers. Poking the cone
 * synchronously — while still inside the transition scope — entangles the
 * affected components' setStates into the batch and keeps it alive.
 */
export function pokeReadersInCone(
	el: Signal<any> | Computed<any>,
	visited: Set<object> = new Set(),
): void {
	for (let s = el._subs; s !== null; s = s._nextSub) {
		const sub = s._sub as Computed<any> & Partial<ReaderNode>
		if (visited.has(sub)) {
			continue
		}
		visited.add(sub)
		if (sub._isReactReader) {
			if (!sub._modified) {
				sub._modified = true
				sub._queue.enqueue(0, sub._run!)
			}
		} else {
			pokeReadersInCone(sub, visited)
			for (let child = sub._child; child !== null; child = child._nextChild) {
				pokeReadersInCone(child, visited)
			}
		}
	}
}

/** Create a persistent reader for one component hook. `wake` is invoked on
 * every invalidation/status change of a linked dep; `urgent` is true when the
 * invalidation came from optimistic propagation — optimistic UI must flush
 * immediately (Solid lane semantics / React useOptimistic), never held to the
 * transition that wrote it. */
export function createReader(name: string, wake: (urgent: boolean) => void): ReaderNode {
	const node = bareNode(name) as ReaderNode
	node._type = EFFECT_TRACKED
	node._isReactReader = true
	node._modified = false
	node._run = () => {
		node._modified = false
		const urgent = !!(node._flags & REACTIVE_OPTIMISTIC_DIRTY) || node._optimisticLane !== undefined
		node._flags &= ~REACTIVE_OPTIMISTIC_DIRTY
		node._optimisticLane = undefined
		node._reentryWorld = undefined
		wake(urgent)
	}
	node._notifyStatus = () => wake(false)
	return node
}

/** Replace the reader's dependency links with `deps` (idempotent; called at
 * every React commit). Deps that drop out react to unobservation only after
 * the new links are in place. */
export function syncReaderDeps(reader: ReaderNode, deps: DepNode[]): void {
	deferUnobserved(() => {
		let toRemove = reader._deps
		while (toRemove !== null) {
			toRemove = unlinkSubs(toRemove)
		}
		reader._deps = null
		reader._depsTail = null
		for (let i = 0; i < deps.length; i++) {
			link(deps[i], reader)
		}
	})
}

/** Tear the reader down (component unmounted). */
export function disposeReader(reader: ReaderNode): void {
	dispose(reader)
}
