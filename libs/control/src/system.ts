/**
 * @lab/control system core — verbatim copy of upstream alien-signals v3.2.1
 * src/system.ts, plus persistent-scratch-stack variants of propagate() and
 * checkDirty() selected by USE_PERSISTENT_STACKS (see flags.ts). The
 * original cons-stack implementations are kept unmodified so flag-off runs
 * are behaviorally identical to upstream.
 */
import { USE_PERSISTENT_STACKS } from './flags.js'

export interface ReactiveNode {
	deps?: Link
	depsTail?: Link
	subs?: Link
	subsTail?: Link
	flags: ReactiveFlags
}

export interface Link {
	version: number
	dep: ReactiveNode
	sub: ReactiveNode
	prevSub: Link | undefined
	nextSub: Link | undefined
	prevDep: Link | undefined
	nextDep: Link | undefined
}

interface Stack<T> {
	value: T
	prev: Stack<T> | undefined
}

export const enum ReactiveFlags {
	None = 0,
	Mutable = 1,
	Watching = 2,
	RecursedCheck = 4,
	Recursed = 8,
	Dirty = 16,
	Pending = 32,
}

// Persistent scratch stacks (USE_PERSISTENT_STACKS). Module-level so they
// are reused across every traversal; safe across re-entrant calls (and even
// across createReactiveSystem instances) because each call operates strictly
// above the base pointer it saved on entry, anod-CTOP style. Appending at
// the top index keeps the arrays PACKED and lets V8 grow the backing store
// geometrically; the arrays never shrink, so steady state allocates nothing.
// Popped slots are not cleared: the pinned garbage is bounded by the
// high-water mark of the deepest traversal ever taken.
const propagateStack: (Link | undefined)[] = []
let propagateStackTop = 0
const checkDirtyStack: Link[] = []
let checkDirtyStackTop = 0

export function createReactiveSystem({
	update,
	notify,
	unwatched,
}: {
	update(sub: ReactiveNode): boolean
	notify(sub: ReactiveNode): void
	unwatched(sub: ReactiveNode): void
}) {
	return {
		link,
		unlink,
		propagate: USE_PERSISTENT_STACKS ? propagatePersistent : propagate,
		checkDirty: USE_PERSISTENT_STACKS ? checkDirtyPersistent : checkDirty,
		shallowPropagate,
	}

	function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
		const prevDep = sub.depsTail
		if (prevDep !== undefined && prevDep.dep === dep) {
			return
		}
		const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps
		if (nextDep !== undefined && nextDep.dep === dep) {
			nextDep.version = version
			sub.depsTail = nextDep
			return
		}
		const prevSub = dep.subsTail
		if (prevSub !== undefined && prevSub.version === version && prevSub.sub === sub) {
			return
		}
		const newLink =
			(sub.depsTail =
			dep.subsTail =
				{
					version,
					dep,
					sub,
					prevDep,
					nextDep,
					prevSub,
					nextSub: undefined,
				})
		if (nextDep !== undefined) {
			nextDep.prevDep = newLink
		}
		if (prevDep !== undefined) {
			prevDep.nextDep = newLink
		} else {
			sub.deps = newLink
		}
		if (prevSub !== undefined) {
			prevSub.nextSub = newLink
		} else {
			dep.subs = newLink
		}
	}

	function unlink(link: Link, sub = link.sub): Link | undefined {
		const { dep, prevDep, nextDep, nextSub, prevSub } = link
		if (nextDep !== undefined) {
			nextDep.prevDep = prevDep
		} else {
			sub.depsTail = prevDep
		}
		if (prevDep !== undefined) {
			prevDep.nextDep = nextDep
		} else {
			sub.deps = nextDep
		}
		if (nextSub !== undefined) {
			nextSub.prevSub = prevSub
		} else {
			dep.subsTail = prevSub
		}
		if (prevSub !== undefined) {
			prevSub.nextSub = nextSub
		} else if ((dep.subs = nextSub) === undefined) {
			unwatched(dep)
		}
		return nextDep
	}

	function propagate(link: Link, innerWrite: boolean): void {
		let next = link.nextSub
		let stack: Stack<Link | undefined> | undefined

		top: do {
			const sub = link.sub
			let flags = sub.flags

			if (
				!(
					flags &
					(ReactiveFlags.RecursedCheck |
						ReactiveFlags.Recursed |
						ReactiveFlags.Dirty |
						ReactiveFlags.Pending)
				)
			) {
				sub.flags = flags | ReactiveFlags.Pending
				if (innerWrite) {
					sub.flags |= ReactiveFlags.Recursed
				}
			} else if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))) {
				flags = ReactiveFlags.None
			} else if (!(flags & ReactiveFlags.RecursedCheck)) {
				sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending
			} else if (
				!(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) &&
				isValidLink(link, sub)
			) {
				sub.flags = flags | (ReactiveFlags.Recursed | ReactiveFlags.Pending)
				flags &= ReactiveFlags.Mutable
			} else {
				flags = ReactiveFlags.None
			}

			if (flags & ReactiveFlags.Watching) {
				notify(sub)
			}

			if (flags & ReactiveFlags.Mutable) {
				const subSubs = sub.subs
				if (subSubs !== undefined) {
					const nextSub = (link = subSubs).nextSub
					if (nextSub !== undefined) {
						stack = { value: next, prev: stack }
						next = nextSub
					}
					continue
				}
			}

			if ((link = next!) !== undefined) {
				next = link.nextSub
				continue
			}

			while (stack !== undefined) {
				link = stack.value!
				stack = stack.prev
				if (link !== undefined) {
					next = link.nextSub
					continue top
				}
			}

			break
		} while (true)
	}

	function checkDirty(link: Link, sub: ReactiveNode): boolean {
		let stack: Stack<Link> | undefined
		let checkDepth = 0
		let dirty = false

		top: do {
			const dep = link.dep
			const flags = dep.flags

			if (sub.flags & ReactiveFlags.Dirty) {
				dirty = true
			} else if (
				(flags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) ===
				(ReactiveFlags.Mutable | ReactiveFlags.Dirty)
			) {
				const subs = dep.subs!
				if (update(dep)) {
					if (subs.nextSub !== undefined) {
						shallowPropagate(subs)
					}
					dirty = true
				}
			} else if (
				(flags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) ===
				(ReactiveFlags.Mutable | ReactiveFlags.Pending)
			) {
				stack = { value: link, prev: stack }
				link = dep.deps!
				sub = dep
				++checkDepth
				continue
			}

			if (!dirty) {
				const nextDep = link.nextDep
				if (nextDep !== undefined) {
					link = nextDep
					continue
				}
			}

			while (checkDepth--) {
				link = stack!.value
				stack = stack!.prev
				if (dirty) {
					const subs = sub.subs!
					if (update(sub)) {
						if (subs.nextSub !== undefined) {
							shallowPropagate(subs)
						}
						sub = link.sub
						continue
					}
					dirty = false
				} else {
					sub.flags &= ~ReactiveFlags.Pending
				}
				sub = link.sub
				const nextDep = link.nextDep
				if (nextDep !== undefined) {
					link = nextDep
					continue top
				}
			}

			return dirty && !!sub.flags
		} while (true)
	}

	/**
	 * propagate() with the cons-cell stack replaced by the module-level
	 * propagateStack. Identical control flow to propagate() above; only the
	 * push/pop sites differ.
	 *
	 * The scratch cursor lives in a local: propagate is never re-entered,
	 * because its only callback, notify(), runs no user code in this
	 * package's API layer (it just queues effects). Inner writes re-enter
	 * propagate only from inside checkDirty's update() — never from inside
	 * another propagate — and checkDirty uses a separate stack. No
	 * try/finally: wrapping the loop in one measured +25% on the smallest
	 * kairo cases (repeatedObservers), and nothing here can throw.
	 * (A future API layer whose notify() runs user code would need the
	 * publish-before-callback discipline used in checkDirtyPersistent.)
	 */
	function propagatePersistent(link: Link, innerWrite: boolean): void {
		const base = propagateStackTop
		let top = base
		let next = link.nextSub

		top: do {
			const sub = link.sub
			let flags = sub.flags

			if (
				!(
					flags &
					(ReactiveFlags.RecursedCheck |
						ReactiveFlags.Recursed |
						ReactiveFlags.Dirty |
						ReactiveFlags.Pending)
				)
			) {
				sub.flags = flags | ReactiveFlags.Pending
				if (innerWrite) {
					sub.flags |= ReactiveFlags.Recursed
				}
			} else if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))) {
				flags = ReactiveFlags.None
			} else if (!(flags & ReactiveFlags.RecursedCheck)) {
				sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending
			} else if (
				!(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) &&
				isValidLink(link, sub)
			) {
				sub.flags = flags | (ReactiveFlags.Recursed | ReactiveFlags.Pending)
				flags &= ReactiveFlags.Mutable
			} else {
				flags = ReactiveFlags.None
			}

			if (flags & ReactiveFlags.Watching) {
				notify(sub)
			}

			if (flags & ReactiveFlags.Mutable) {
				const subSubs = sub.subs
				if (subSubs !== undefined) {
					const nextSub = (link = subSubs).nextSub
					if (nextSub !== undefined) {
						propagateStack[top++] = next
						next = nextSub
					}
					continue
				}
			}

			if ((link = next!) !== undefined) {
				next = link.nextSub
				continue
			}

			while (top > base) {
				link = propagateStack[--top]!
				if (link !== undefined) {
					next = link.nextSub
					continue top
				}
			}

			break
		} while (true)
	}

	/**
	 * checkDirty() with the cons-cell stack replaced by the module-level
	 * checkDirtyStack; the stack height above `base` replaces the checkDepth
	 * counter.
	 *
	 * update() runs user getters that may read other computeds and re-enter
	 * this function (or propagate, via inner writes), so re-entrant
	 * activations must see where our frames end: the local cursor is
	 * published to checkDirtyStackTop immediately before every update()
	 * call, and a nested activation's exit leaves the module top at its own
	 * base (=== our published top), keeping the local cursor valid.
	 *
	 * Exception safety without any try region in this function (a try/finally
	 * around the loop measured +25% on the smallest kairo cases; a try/catch
	 * at the call sites still measured +5% on sbench updateSignals): update()
	 * is the only operation here that can throw, so both call sites go
	 * through updateGuarded(), whose catch restores the module top to this
	 * activation's base and rethrows. An unwind through nested activations
	 * therefore steps the top down monotonically to the outermost base —
	 * correct even when a user getter catches the error mid-flight and keeps
	 * reading other computeds.
	 */
	function updateGuarded(node: ReactiveNode, base: number): boolean {
		try {
			return update(node)
		} catch (e) {
			checkDirtyStackTop = base
			throw e
		}
	}

	function checkDirtyPersistent(link: Link, sub: ReactiveNode): boolean {
		const base = checkDirtyStackTop
		let top = base
		let dirty = false

		top: do {
			const dep = link.dep
			const flags = dep.flags

			if (sub.flags & ReactiveFlags.Dirty) {
				dirty = true
			} else if (
				(flags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) ===
				(ReactiveFlags.Mutable | ReactiveFlags.Dirty)
			) {
				const subs = dep.subs!
				checkDirtyStackTop = top
				if (updateGuarded(dep, base)) {
					if (subs.nextSub !== undefined) {
						shallowPropagate(subs)
					}
					dirty = true
				}
			} else if (
				(flags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) ===
				(ReactiveFlags.Mutable | ReactiveFlags.Pending)
			) {
				checkDirtyStack[top++] = link
				link = dep.deps!
				sub = dep
				continue
			}

			if (!dirty) {
				const nextDep = link.nextDep
				if (nextDep !== undefined) {
					link = nextDep
					continue
				}
			}

			while (top > base) {
				link = checkDirtyStack[--top]
				if (dirty) {
					const subs = sub.subs!
					checkDirtyStackTop = top
					if (updateGuarded(sub, base)) {
						if (subs.nextSub !== undefined) {
							shallowPropagate(subs)
						}
						sub = link.sub
						continue
					}
					dirty = false
				} else {
					sub.flags &= ~ReactiveFlags.Pending
				}
				sub = link.sub
				const nextDep = link.nextDep
				if (nextDep !== undefined) {
					link = nextDep
					continue top
				}
			}

			checkDirtyStackTop = base
			return dirty && !!sub.flags
		} while (true)
	}

	function shallowPropagate(link: Link): void {
		do {
			const sub = link.sub
			const flags = sub.flags
			if ((flags & (ReactiveFlags.Pending | ReactiveFlags.Dirty)) === ReactiveFlags.Pending) {
				sub.flags = flags | ReactiveFlags.Dirty
				if (
					(flags & (ReactiveFlags.Watching | ReactiveFlags.RecursedCheck)) ===
					ReactiveFlags.Watching
				) {
					notify(sub)
				}
			}
		} while ((link = link.nextSub!) !== undefined)
	}

	function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
		let link = sub.depsTail
		while (link !== undefined) {
			if (link === checkLink) {
				return true
			}
			link = link.prevDep
		}
		return false
	}
}
