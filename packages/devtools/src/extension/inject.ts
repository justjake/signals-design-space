/**
 * Page-world script. Attaches the collector to the page's cosignals engine (or
 * reuses one the app already installed inline), then pushes a bounded snapshot
 * to the content script on every flush. Runs in the page's realm so it shares
 * the app's cosignals module singleton via the trace-hook seam.
 *
 * Bundled to a plain .js and injected by the content script (see manifest
 * web_accessible_resources). Same-instance caveat: the app must use the same
 * cosignals build; cosignals's trace hook is a module singleton, so one attach observes
 * all activity in that realm.
 */
import type { Backend } from '../protocol.ts'
import { attachCosignalsDevtools } from '../cosignals.ts'
import { CHANNEL, type DevtoolsMessage, isDevtoolsMessage } from './messages.ts'
import { buildSnapshot } from './snapshot.ts'

/**
 * Minimum gap between flush-driven snapshot posts. Building and cloning a
 * snapshot is the expensive part of the pipe, so a busy app's flushes (one per
 * microtask batch) are coalesced: at most one post per interval, always
 * carrying the state at post time, so the final post after a burst reflects
 * where the burst ended.
 */
const POST_INTERVAL_MS = 80

function post(backend: Backend): void {
	const msg: DevtoolsMessage = { channel: CHANNEL, kind: 'snapshot', snapshot: buildSnapshot(backend) }
	window.postMessage(msg, '*')
}

function start(): void {
	// Reuse an inline-installed collector if present; else attach our own.
	const existing = (globalThis as { __SIGNALS_DEVTOOLS__?: Backend }).__SIGNALS_DEVTOOLS__
	const backend = existing ?? attachCosignalsDevtools().collector

	// Trailing-edge coalescing: the first flush of a burst arms a timer; every
	// flush inside the window rides the same pending post.
	let pending: ReturnType<typeof setTimeout> | undefined
	backend.subscribe(() => {
		if (pending !== undefined) return
		pending = setTimeout(() => {
			pending = undefined
			post(backend)
		}, POST_INTERVAL_MS)
	})
	// Answer explicit requests (panel connect / reload) immediately, so an
	// opening panel is never blank while a coalescing window runs out.
	window.addEventListener('message', (e: MessageEvent) => {
		if (e.source === window && isDevtoolsMessage(e.data) && e.data.kind === 'request') post(backend)
	})
	post(backend)
}

start()
