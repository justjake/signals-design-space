/** Messages on the page ↔ panel pipe. All structured-clone-safe. */
import type { Snapshot } from './snapshot.ts'

export const CHANNEL = 'signals-devtools'

/** Page → panel: a fresh engine snapshot (pushed on each collector flush). */
export interface SnapshotMessage {
	channel: typeof CHANNEL
	kind: 'snapshot'
	snapshot: Snapshot
}

/** Panel → page: ask for a snapshot now (e.g. on first connect). */
export interface RequestMessage {
	channel: typeof CHANNEL
	kind: 'request'
}

export type DevtoolsMessage = SnapshotMessage | RequestMessage

export function isDevtoolsMessage(v: unknown): v is DevtoolsMessage {
	return typeof v === 'object' && v !== null && (v as { channel?: unknown }).channel === CHANNEL
}
