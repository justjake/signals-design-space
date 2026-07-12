/**
 * SignalScopeProvider: the component that carries transition worlds for
 * one root.
 *
 * Its reducer state is the set of transition draft ids this root has been
 * told about. Because every draft id is dispatched inside its
 * transition's scope, React's own update queues decide which render
 * passes see which ids: urgent passes skip the pending update and see the
 * committed base world, the transition's own passes include it, and a
 * rebased retry recomputes the same queue over new state. That queue
 * behavior is the entire definition of a render pass's world — the
 * bindings keep no lane bookkeeping of their own.
 *
 * The scope's render notes the pass's world in the host (for plain
 * latest()/isPending() calls in render bodies and for hooks mounting
 * inside the pass). Its first child is a null-rendering commit marker,
 * whose layout effect confirms the drafts before application descendants'
 * layout effects run. The ScopeContext value is an identity-stable record
 * and the application children element is unchanged, so only components
 * with their own pending updates render. Value subscribers are woken per
 * drafted atom through their own reducers.
 *
 * The reducer returns a fresh state object even for an id it already
 * contains, to handle one hazard: a wake for an already-rendered draft (a
 * later write appended to it) must still re-render the transition's
 * passes against the completed batch, or a pass could commit half a
 * batch.
 */
import * as React from 'react'
import { NO_EVENT } from '../graph.ts'
import { isLiveDraft, type DraftId } from '../worlds.ts'
import { getActiveTracer } from '../tracer.ts'
import { confirmCommit, noteRenderWorld, registerProvider, type SignalScope } from './host.ts'

/** Reducer state for a scope or hook: the live draft ids delivered to it
 * so far, i.e. the world its render passes carry. */
export interface WorldState {
	ids: readonly DraftId[]
}

export const EMPTY_WORLD: WorldState = { ids: [] }

/** Shared by the scope and every useValue hook: accumulate live draft
 * ids and prune dead ones — retired and discarded drafts resolve to base
 * state anyway, and a long-lived subscriber must not grow history
 * forever. Always returns a fresh object so a re-dispatched id still
 * restarts the pass (see the header). */
export function worldsReducer(prev: WorldState, id: DraftId): WorldState {
	const live: DraftId[] = []
	let add = isLiveDraft(id)
	for (const draft of prev.ids) {
		if (isLiveDraft(draft)) {
			live.push(draft)
			add = add && draft !== id
		}
	}
	if (add) {
		live.push(id)
	}
	const ids = !add && live.length === prev.ids.length ? prev.ids : live
	return { ids }
}

/** The scope's identity-stable record, or null outside any
 * SignalScopeProvider. Scope-consuming hooks throw on null (see
 * requireScope in hooks.ts). */
export const ScopeContext = React.createContext<SignalScope | null>(null)

export interface SignalScopeProviderProps {
	/** Keys this root's committed world for committed(x, container) reads;
	 * wrapCreateRoot passes the root's DOM element. Hooks always use the
	 * provider record itself as their committed-world key, so this is needed
	 * only by reads outside React. */
	container?: object
	children?: React.ReactNode
}

/** A separate first-child fiber gives this layout effect commit order
 * before the application subtree. Registration lives on the same stable
 * marker so the scope is registered before its first confirmation and is
 * unregistered when the provider unmounts. */
function SignalScopeCommit({ scope, world }: { scope: SignalScope; world: WorldState }): null {
	React.useLayoutEffect(() => registerProvider(scope), [scope])
	React.useLayoutEffect(() => {
		getActiveTracer()?.emit('root-commit', null, NO_EVENT, { world: world.ids })
		confirmCommit(scope, world.ids)
	}, [scope, world])
	return null
}

export function SignalScopeProvider(props: SignalScopeProviderProps): React.ReactElement {
	const [world, dispatch] = React.useReducer(worldsReducer, EMPTY_WORLD)
	const container = props.container ?? null
	const scope = React.useMemo<SignalScope>(
		() => ({ dispatch, container, committing: false }),
		[dispatch, container],
	)
	// Note this pass's world in the host. Every pass that carries drafts
	// re-renders this scope (the drafts live in its reducer state), so the
	// note lands at the top of the pass, in tree order, before any
	// component can read.
	noteRenderWorld(scope, world.ids)
	return React.createElement(
		ScopeContext.Provider,
		{ value: scope },
		React.createElement(SignalScopeCommit, { scope, world }),
		props.children,
	)
}

/** A React root whose render() wraps the tree in that root's own
 * SignalScopeProvider. */
export interface WrappedRoot {
	render(node: React.ReactNode): void
	unmount(): void
}

/**
 * A createRoot with the scope pre-installed: every render() is wrapped in
 * this root's SignalScopeProvider, so apps (and the shared battery) get
 * transition worlds and per-root committed views without composing
 * anything.
 */
export function wrapCreateRoot(
	createRoot: (
		el: Element,
		opts?: unknown,
	) => { render(node: React.ReactNode): void; unmount(): void },
): (el: Element, opts?: unknown) => WrappedRoot {
	return (el, opts) => {
		const root = createRoot(el, opts)
		return {
			render(node: React.ReactNode) {
				root.render(React.createElement(SignalScopeProvider, { container: el }, node))
			},
			unmount() {
				root.unmount()
			},
		}
	}
}
