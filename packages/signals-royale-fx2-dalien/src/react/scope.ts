/**
 * SignalScope: the per-root world carrier.
 *
 * Its reducer state is the set of transition draft ids this root has been
 * told about. Because every draft dispatch happens inside its transition's
 * scope, React's own update queues decide
 * which render passes see which ids: urgent passes skip pending transition
 * updates (world = committed base), the transition's own passes include
 * them, and a rebased retry recomputes the same queue over new state. That
 * IS the render-pass world definition — no lane bookkeeping of our own.
 *
 * The scope's render does exactly two things per world-carrying pass: it
 * notes the pass's world in the host (for plain latest()/isPending() calls
 * below and for hooks mounting inside the pass — validity-gated there), and
 * at commit it confirms the drafts this root carried. It deliberately does
 * NOT wake its subtree: the ScopeContext value is an identity-stable record
 * and the children element is unchanged, so React bails out below the scope
 * and only components with their own pending updates render — value
 * subscribers are woken per drafted cell through their own reducers.
 *
 * The fresh state object handles one hazard: a wake for a draft id the state
 * already contains (an append to an already-rendered draft) still re-renders
 * the transition's passes against the completed batch — a pass never commits
 * half a batch.
 */
import * as React from 'react'
import { NO_EVENT } from '../graph.ts'
import { isLiveDraft, type DraftId } from '../worlds.ts'
import { getActiveTracer } from '../tracer.ts'
import { confirmCommit, noteRenderWorld, registerProvider, type ProviderRecord } from './host.ts'

export interface WorldState {
	ids: readonly DraftId[]
}

export const EMPTY_WORLD: WorldState = { ids: [] }

/** Shared by the scope and every useValue hook: accumulate live draft ids,
 * prune dead ones (retired and discarded drafts resolve to base state anyway,
 * and a long-lived subscriber must not grow history forever), and always
 * return a fresh object so a re-dispatched id still restarts the pass. */
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

/** The scope's identity-stable record, or null outside any SignalScope.
 * Scope-consuming hooks throw on null — there is no mode without a scope
 * (see hooks.ts requireScope). */
export const ScopeContext = React.createContext<ProviderRecord | null>(null)

export interface SignalScopeProps {
	container?: object
	children?: React.ReactNode
}

export function SignalScope(props: SignalScopeProps): React.ReactElement {
	const [world, dispatch] = React.useReducer(worldsReducer, EMPTY_WORLD)
	const container = props.container ?? null
	const record = React.useMemo<ProviderRecord>(
		() => ({ dispatch, container }),
		[dispatch, container],
	)
	// Note this pass's world. Every pass that carries drafts re-renders this
	// scope (the drafts live in its reducer state), so the note lands at the
	// top of the pass, in tree order, before any component can read.
	noteRenderWorld(record, world.ids)
	React.useLayoutEffect(() => registerProvider(record), [record])
	React.useLayoutEffect(() => {
		// Runs exactly at this root's commits of world-carrying passes.
		getActiveTracer()?.emit('root-commit', null, NO_EVENT, { world: world.ids })
		confirmCommit(record, world.ids)
	}, [record, world])
	return React.createElement(ScopeContext.Provider, { value: record }, props.children)
}

export interface WrappedRoot {
	render(node: unknown): void
	unmount(): void
}

/**
 * A createRoot with the scope pre-installed: every render() is wrapped in
 * this root's SignalScope, so apps (and the shared battery) get transition
 * worlds and per-root committed views without composing anything.
 */
export function wrapCreateRoot(
	createRoot: (el: Element, opts?: unknown) => { render(node: unknown): void; unmount(): void },
): (el: Element, opts?: unknown) => WrappedRoot {
	return (el, opts) => {
		const root = createRoot(el, opts)
		return {
			render(node: unknown) {
				root.render(React.createElement(SignalScope, { container: el }, node as React.ReactNode))
			},
			unmount() {
				root.unmount()
			},
		}
	}
}
