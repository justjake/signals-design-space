/**
 * SignalsFrameworkProvider: the component that carries transition worlds for
 * one root.
 *
 * Its reducer state is the set of transition draft ids this root has been
 * told about. Because every draft id is dispatched inside its
 * transition's context, React's own update queues decide which render
 * passes see which ids: urgent passes skip the pending update and see the
 * committed base world, the transition's own passes include it, and a
 * rebased retry recomputes the same queue over new state. That queue
 * behavior is the entire definition of a render pass's world — the
 * bindings keep no lane bookkeeping of their own.
 *
 * The connection's render notes the pass's world in the host (for plain
 * latest()/isPending() calls in render bodies and for hooks mounting
 * inside the pass). Its first child is a null-rendering commit marker,
 * whose layout effect confirms the drafts before application descendants'
 * layout effects run. The context value is an identity-stable connection
 * record and the application children element is unchanged, so only
 * components with their own pending updates render. Value subscribers
 * are woken per drafted atom through their own reducers.
 *
 * The reducer returns a fresh state object even for an id it already
 * contains, to handle one hazard: a wake for an already-rendered draft (a
 * later write appended to it) must still re-render the transition's
 * passes against the completed batch, or a pass could commit half a
 * batch.
 */
import * as React from 'react'
import { NO_EVENT } from '../graph.ts'
import { getActiveTracer } from '../tracer.ts'
import { isLiveDraft, type DraftId } from '../worlds.ts'
import {
	confirmRootCommit,
	noteRenderWorld,
	registerRootConnection,
	type ReactRootConnection,
} from './host.ts'

/** Reducer state for a connection or hook: the live draft ids delivered to it
 * so far, i.e. the world its render passes carry. */
export interface WorldState {
	ids: readonly DraftId[]
}

export const EMPTY_WORLD: WorldState = { ids: [] }

/** Shared by the connection and every useValue hook: accumulate live draft
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

/** The nearest root connection, or null outside a provider. Hooks consume
 * it, and providers use it to detect an ancestor provider. */
export const ReactRootConnectionContext = React.createContext<ReactRootConnection | null>(null)

export interface SignalsFrameworkProviderProps {
	children?: React.ReactNode
}

/** A separate first-child fiber gives this layout effect commit order
 * before the application subtree. Registration lives on the same stable
 * marker so the connection is registered before its first confirmation
 * and is unregistered when the provider unmounts. */
function ReactRootCommit({
	connection,
	world,
}: {
	connection: ReactRootConnection
	world: WorldState
}): null {
	React.useLayoutEffect(() => registerRootConnection(connection), [connection])
	React.useLayoutEffect(() => {
		confirmRootCommit(connection, world.ids)
	}, [connection, world])
	return null
}

/** Connect a React subtree to the signals runtime. A descendant provider
 * would replace this connection for part of the subtree, so nesting throws. */
export function SignalsFrameworkProvider(props: SignalsFrameworkProviderProps): React.ReactElement {
	if (React.useContext(ReactRootConnectionContext) !== null) {
		const error = new Error(
			'SignalsFrameworkProvider cannot be nested inside another ' +
				'SignalsFrameworkProvider. Mount it outside the other provider, ' +
				'or use wrapCreateRoot(createRoot).',
		)
		getActiveTracer()?.emit('policy-error', null, NO_EVENT, {
			error,
			phase: 'nested-provider',
		})
		throw error
	}
	const [world, dispatch] = React.useReducer(worldsReducer, EMPTY_WORLD)
	const connection = React.useMemo<ReactRootConnection>(
		() => ({ dispatch, committing: false }),
		[dispatch],
	)
	// Note this pass's world in the host. Every pass that carries drafts
	// re-renders this provider (the drafts live in its reducer state), so
	// the note lands at the top of the pass, in tree order, before any
	// component can read.
	noteRenderWorld(connection, world.ids)
	return React.createElement(
		ReactRootConnectionContext.Provider,
		{ value: connection },
		React.createElement(ReactRootCommit, { connection, world }),
		props.children,
	)
}

/** A React root whose render() wraps the tree in a
 * SignalsFrameworkProvider. */
export interface WrappedRoot {
	render(node: React.ReactNode): void
	unmount(): void
}

/**
 * A createRoot with the provider pre-installed: every render() is wrapped
 * in this root's SignalsFrameworkProvider, so apps get transition worlds
 * without composing anything.
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
				root.render(React.createElement(SignalsFrameworkProvider, null, node))
			},
			unmount() {
				root.unmount()
			},
		}
	}
}
