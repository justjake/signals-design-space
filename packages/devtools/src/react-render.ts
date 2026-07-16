/**
 * React render-causality channel — devtools-only, via bippy.
 *
 * The signal engine knows *notify* (a state change told a watcher), but not
 * *render*: which React components actually re-rendered, and why. React answers
 * that structurally — diff each committed fiber against its previous version;
 * a component with no changed props/state/hooks/context re-rendered only because
 * an ancestor did (the cascade). bippy reads React's fiber tree through the
 * DevTools global hook, so this observes React directly and never touches fx2.
 *
 * On each commit we walk the fibers that rendered, top-down, and record one
 * `render` event per component with real causality: a child chains to its
 * parent's render (the cascade), and a cascade root — the top component that
 * re-rendered — chains to the signal event that triggered the pass. So a burst
 * of "App re-rendered its children" reads as one tree rooted at the click,
 * never a dozen uncaused renders.
 *
 * This is a second, independent channel; it does not use fx2 node identity —
 * render events carry the component name + fiber id in `data` and relate purely
 * through cause pointers.
 */
import {
	getDisplayName,
	getFiberId,
	getTimings,
	instrument,
	isCompositeFiber,
	secure,
	traverseContexts,
	traverseProps,
	traverseRenderedFibers,
	traverseState,
	type Fiber,
	type FiberRoot,
	type RenderPhase,
} from 'bippy'
import type { Collector } from './collector.ts'
import type { EventId } from './protocol.ts'

/** Why a fiber rendered, in the order React resolves it: its own change wins,
 * else it's a parent-driven cascade. Mirrors React DevTools' getChangeDescription. */
function renderReason(fiber: Fiber, phase: RenderPhase, parentRendered: boolean): string {
	// A first render (mount phase, or no previous fiber to diff against) is a mount.
	if (phase === 'mount' || fiber.alternate === null) return 'mounted'
	const props: string[] = []
	traverseProps(fiber, (name, next, prev) => {
		if (!Object.is(prev, next)) props.push(name)
	})
	if (props.length > 0) return `props changed: ${props.slice(0, 4).join(', ')}${props.length > 4 ? '…' : ''}`
	let stateChanged = false
	traverseState(fiber, (next, prev) => {
		if (next && prev && !Object.is(prev.memoizedState, next.memoizedState)) stateChanged = true
	})
	if (stateChanged) return 'state / hook changed'
	let contextChanged = false
	traverseContexts(fiber, (next, prev) => {
		if (next && prev && !Object.is(prev.memoizedValue, next.memoizedValue)) contextChanged = true
	})
	if (contextChanged) return 'context changed'
	if (parentRendered) return 'parent rendered'
	return 'rendered'
}

/**
 * Install the render observer. `latestSignalCause` supplies the id of the most
 * recent signal event (a notify/write) so a cascade root can chain to what
 * triggered the pass. Returns a detach that quiets the channel — bippy patches
 * the shared DevTools hook once, so detach flips a local flag rather than
 * un-patching.
 */
export function attachReactRenderTracer(collector: Collector, latestSignalCause: () => EventId): () => void {
	let active = true
	instrument(
		secure({
			onCommitFiberRoot(_rendererID: number, root: FiberRoot) {
				if (!active) return
				// fiber id → its render event this commit, so a child finds its parent.
				const rendered = new Map<number, EventId>()
				traverseRenderedFibers(root, (fiber: Fiber, phase: RenderPhase) => {
					if (phase === 'unmount' || !isCompositeFiber(fiber)) return
					// Nearest ancestor that also rendered this commit → the cascade parent.
					let cause: EventId = 0 as EventId
					for (let p = fiber.return; p !== null && p !== undefined; p = p.return) {
						const parentEvent = rendered.get(getFiberId(p))
						if (parentEvent !== undefined) {
							cause = parentEvent
							break
						}
					}
					const parentRendered = cause !== (0 as EventId)
					// A cascade root (no rendered ancestor) is chained to the signal
					// event that triggered this pass, so the render tree roots at the cause.
					if (!parentRendered) cause = latestSignalCause()
					const timings = getTimings(fiber)
					const id = collector.record('render', undefined, cause, undefined, {
						component: getDisplayName(fiber) ?? 'Anonymous',
						fiberId: getFiberId(fiber),
						reason: renderReason(fiber, phase, parentRendered),
						took: Math.round((timings.selfTime ?? 0) * 1000),
					})
					rendered.set(getFiberId(fiber), id)
				})
			},
		}),
	)
	return () => {
		active = false
	}
}
