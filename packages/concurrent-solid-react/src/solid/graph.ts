import { CONFIG_AUTO_DISPOSE, REACTIVE_RECOMPUTING_DEPS, REACTIVE_ZOMBIE } from './constants.js'
import { deleteFromHeap } from './heap.js'
import { disposeChildren } from './owner.js'
import { dirtyQueue, zombieQueue } from './scheduler.js'
import type { Computed, Link, Signal } from './types.js'

// [react-adapt E13] While a React commit re-syncs a component reader's
// dependency links, a dep may momentarily lose its last subscriber and then
// immediately regain it. Deferring the unobserved/auto-dispose reaction to
// the end of the re-sync keeps such deps (and their in-flight async work)
// alive across the swap.
let deferredUnobserved: Set<Signal<any> | Computed<any>> | null = null

export function deferUnobserved<T>(fn: () => T): T {
	const prev = deferredUnobserved
	const set = (deferredUnobserved = new Set())
	try {
		return fn()
	} finally {
		deferredUnobserved = prev
		for (const dep of set) {
			if (dep._subs === null) {
				reactToUnobserved(dep)
			}
		}
	}
}

function reactToUnobserved(dep: Signal<any> | Computed<any>): void {
	dep._unobserved?.()
	// No more subscribers; only tear down if CONFIG_AUTO_DISPOSE is set.
	const c = dep as Computed<any>
	;(c as any)._fn &&
		c._config & CONFIG_AUTO_DISPOSE &&
		!(c._flags & REACTIVE_ZOMBIE) &&
		unobserved(c)
}

// https://github.com/stackblitz/alien-signals/blob/v2.0.3/src/system.ts#L100
export function unlinkSubs(link: Link): Link | null {
	const dep = link._dep
	const nextDep = link._nextDep
	const nextSub = link._nextSub
	const prevSub = link._prevSub
	if (nextSub !== null) {
		nextSub._prevSub = prevSub
	} else {
		dep._subsTail = prevSub
	}

	if (prevSub !== null) {
		prevSub._nextSub = nextSub
	} else {
		dep._subs = nextSub
		if (nextSub === null) {
			if (deferredUnobserved !== null) {
				deferredUnobserved.add(dep)
			} else {
				reactToUnobserved(dep)
			}
		}
	}
	return nextDep
}

export function trimStaleDeps(el: Computed<any>): void {
	const depsTail = el._depsTail
	let toRemove = depsTail !== null ? depsTail._nextDep : el._deps
	if (toRemove !== null) {
		do {
			toRemove = unlinkSubs(toRemove)
		} while (toRemove !== null)
		if (depsTail !== null) {
			depsTail._nextDep = null
		} else {
			el._deps = null
		}
	}
}

export function unobserved(el: Computed<unknown>) {
	deleteFromHeap(el, el._flags & REACTIVE_ZOMBIE ? zombieQueue : dirtyQueue)
	let dep = el._deps
	while (dep !== null) {
		dep = unlinkSubs(dep)
	}
	el._deps = null
	el._depsTail = null
	disposeChildren(el, true)
}

// https://github.com/stackblitz/alien-signals/blob/v2.0.3/src/system.ts#L52
export function link(
	dep: Signal<any> | Computed<any>,
	sub: Computed<any>,
	pendingObserver: boolean = false,
) {
	const prevDep = sub._depsTail
	if (prevDep !== null && prevDep._dep === dep) {
		prevDep._pendingObserver = pendingObserver
		return
	}

	let nextDep: Link | null = null
	const isRecomputing = sub._flags & REACTIVE_RECOMPUTING_DEPS
	if (isRecomputing) {
		nextDep = prevDep !== null ? prevDep._nextDep : sub._deps
		if (nextDep !== null && nextDep._dep === dep) {
			sub._depsTail = nextDep
			nextDep._pendingObserver = pendingObserver
			return
		}
	}

	const prevSub = dep._subsTail
	if (prevSub !== null && prevSub._sub === sub && (!isRecomputing || isValidLink(prevSub, sub))) {
		prevSub._pendingObserver = pendingObserver
		return
	}

	const newLink =
		(sub._depsTail =
		dep._subsTail =
			{
				_dep: dep,
				_sub: sub,
				_nextDep: nextDep,
				_prevSub: prevSub,
				_nextSub: null,
				_pendingObserver: pendingObserver,
			})
	if (prevDep !== null) {
		prevDep._nextDep = newLink
	} else {
		sub._deps = newLink
	}

	if (prevSub !== null) {
		prevSub._nextSub = newLink
	} else {
		dep._subs = newLink
	}
}

// https://github.com/stackblitz/alien-signals/blob/v2.0.3/src/system.ts#L284
function isValidLink(checkLink: Link, sub: Computed<unknown>): boolean {
	const depsTail = sub._depsTail
	if (depsTail !== null) {
		let link = sub._deps!
		do {
			if (link === checkLink) {
				return true
			}
			if (link === depsTail) {
				break
			}
			link = link._nextDep!
		} while (link !== null)
	}
	return false
}
