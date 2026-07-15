import { useSyncExternalStore } from 'react'
import type { Backend } from '../protocol.ts'

/**
 * Re-render on each collector flush. getSnapshot returns the total event count
 * — a cheap monotonic value that changes exactly when new entries arrive, so
 * useSyncExternalStore stays stable (no fresh-object identity churn). The
 * panel reads live data via the view-model in render, keyed on this.
 */
export function useBackend(backend: Backend): number {
	return useSyncExternalStore(
		(cb) => backend.subscribe(cb),
		() => backend.counts().events,
		() => backend.counts().events,
	)
}
