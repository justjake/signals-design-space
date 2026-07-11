/**
 * Transition writes. The helper opens an engine draft, dispatches its id to
 * every SignalScope INSIDE React.startTransition (so the dispatches ride the
 * transition's lanes), and classifies the scope's writes into the draft.
 *
 * Plain React.startTransition works too: the first engine write inside any
 * transition context is detected through the ambient classifier in host.ts,
 * which opens and broadcasts a draft on the spot.
 */
import * as React from 'react'
import { openDraft, runInDraft, sealDraft } from '../worlds.ts'
import { broadcastDraft } from './host.ts'

function runDraftScope(scope: () => void): void {
	const draft = openDraft()
	broadcastDraft(draft)
	try {
		runInDraft(draft, scope)
	} finally {
		sealDraft(draft)
	}
}

/** Run writes as one transition batch: invisible to base-state readers and
 * the committed DOM until React commits the transition. */
export function startTransitionWrite(scope: () => void): void {
	React.startTransition(() => {
		runDraftScope(scope)
	})
}

/** useTransition married to an engine batch: isPending covers the batch's
 * whole lifetime, including renders it holds open. */
export function useSignalTransition(): [boolean, (scope: () => void) => void] {
	const [isPending, startTransition] = React.useTransition()
	const startRef = React.useRef<((scope: () => void) => void) | null>(null)
	startRef.current ??= (scope) => {
		startTransition(() => {
			runDraftScope(scope)
		})
	}
	return [isPending, startRef.current]
}
