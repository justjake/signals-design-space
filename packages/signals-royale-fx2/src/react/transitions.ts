/**
 * Transition write helpers. The first engine write inside React's
 * transition context is detected by host.ts, which opens and broadcasts
 * one draft for that React transition object. The signal batch only
 * defers graph delivery until the callback finishes.
 */
import * as React from 'react'
import { batch } from '../graph.ts'

/** Run writes in one signal batch and transition draft, invisible to
 * base-state readers and the committed DOM until React commits. */
export function startSignalTransition(scope: () => void): void {
	React.startTransition(() => {
		batch(scope)
	})
}

/** React's useTransition combined with a signal batch and engine draft:
 * isPending covers the draft's whole lifetime, including held renders. */
export function useSignalTransition(): [boolean, (scope: () => void) => void] {
	const [isPending, startTransition] = React.useTransition()
	const startRef = React.useRef<((scope: () => void) => void) | null>(null)
	startRef.current ??= (scope) => {
		startTransition(() => {
			batch(scope)
		})
	}
	return [isPending, startRef.current]
}
