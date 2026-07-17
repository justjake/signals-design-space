/**
 * React render-causality channel — devtools-only, via bippy.
 *
 * The signal engine knows *notify* (a state change told a watcher), but not
 * *render*: which React components actually re-rendered, and why. React answers
 * that structurally — diff each committed fiber against its previous version;
 * a component with no changed props/state/hooks/context re-rendered only because
 * an ancestor did (the cascade). bippy reads React's fiber tree through the
 * DevTools global hook, so this observes React directly and never touches cosignals.
 *
 * On each commit we walk the fibers that rendered, top-down, and record one
 * `render` event per component with real causality: a child chains to its
 * parent's render (the cascade), and a cascade root — the top component that
 * re-rendered — chains to the signal event that triggered the pass. So a burst
 * of "App re-rendered its children" reads as one tree rooted at the click,
 * never a dozen uncaused renders.
 *
 * This is a second, independent channel. Render events carry the component
 * name and fiber id in `data` and relate through cause pointers. The adapter
 * may also use committed hook refs to label its watcher nodes; Bippy still
 * does not inspect or mutate the signal graph.
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

/**
 * Why a fiber rendered, in the order React resolves it: its own change wins,
 * otherwise it is a parent-driven cascade.
 */
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
export function attachReactRenderTracer(
	collector: Collector,
	latestSignalCause: () => EventId,
	labelWatcher: (watcher: object, component: string) => void,
): () => void {
	let active = true
	instrument(
		secure({
			onCommitFiberRoot(_rendererID: number, root: FiberRoot) {
				if (!active) return
				// Never observe the devtools' own React root — it re-renders on every
				// collector flush, which would feed back into itself (a write →
				// record → flush → panel render → record → … runaway). Identify it by
				// the markers the panel and its launch button always render, so every
				// mount path is covered (inline mountDevtools AND the DevtoolsPanelButton
				// the playground uses), not just those that tag their container.
				const container = root.containerInfo as Element | null
				if (
					container !== null &&
					typeof container.querySelector === 'function' &&
					(container.closest?.('.signals-devtools-root, .signals-devtools-launch') !== null ||
						container.querySelector('.signals-devtools-root, .signals-devtools-launch') !== null)
				) {
					return
				}
				// fiber id → its render event this commit, so a child finds its parent.
				const rendered = new Map<number, EventId>()
				traverseRenderedFibers(root, (fiber: Fiber, phase: RenderPhase) => {
					if (phase === 'unmount' || !isCompositeFiber(fiber)) return
					const component = getDisplayName(fiber) ?? 'Anonymous'
					// useValue keeps its subscription state in a ref. Layout effects
					// install the watcher before React reports this commit, so the
					// committed hook list provides the component-to-watcher relation
					// without owner-stack capture in the signal bindings.
					traverseState(fiber, (state) => {
						const ref = state?.memoizedState
						if (ref === null || typeof ref !== 'object' || !('current' in ref)) return
						const current = ref.current
						if (current === null || typeof current !== 'object' || !('watcher' in current)) return
						const watcher = current.watcher
						if (watcher !== null && typeof watcher === 'object') {
							labelWatcher(watcher, component)
						}
					})
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
						component,
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
