/**
 * This module glues the engine's drafts and worlds to a running React
 * tree.
 *
 * The design premise is that React itself decides which render pass sees
 * which drafts. Draft ids are dispatched into ordinary React state (each
 * CosignalsProvider's reducer, each useSignal hook's reducer) from
 * inside the owning transition, so React's own update queues determine
 * visibility: urgent passes skip the pending update, the transition's passes include
 * it. These bindings never guess at lanes or patch React; everything runs
 * on stock React through public state and context primitives.
 *
 * This file contains, in order: render detection and the write-during-
 * render guard; the render-world note (how a render pass declares which
 * world it is); draft-wake dispatch and late-subscription repair; and the
 * registry that broadcasts new drafts to connections and retires them when
 * every connection has committed.
 */
// The `scheduler` package ships untyped; the ambient declaration lives in
// scheduler.d.ts. The reference pulls it into any program that includes this
// file (external tools typecheck the adapter without the full src tree).
/// <reference path="./scheduler.d.ts" />
import * as React from 'react'
import * as Scheduler from 'scheduler'
import {
	trace,
	Flag,
	isUninitialized,
	NO_EVENT,
	pokeDraftWatchers,
	repumpDeferredLanes,
	setLanePump,
	type ProducerNode,
	type TraceEventId,
} from '../graph.ts'
import {
	type Draft,
	type DraftId,
	draftsAffecting,
	openDraft,
	resolveState,
	retireDraft,
	setAmbientClassifier,
	worldOf,
} from '../worlds.ts'
import { resetEngineForTest, setRenderWorldProvider, setRenderWriteGuard } from '../signals.ts'

/**
 * One registered connection per CosignalsProvider. The record is
 * identity-stable for the root's lifetime. It is the context value, so
 * publishing it does not re-render consumers, and the key used to
 * validate render-world notes.
 */
export interface ReactRootConnection {
	/**
	 * Draft ids delivered here become part of the worlds this root's
	 * render passes carry.
	 */
	dispatch: (id: DraftId) => void
	/**
	 * True only while the first-child commit marker confirms this root's
	 * current render, before descendant layout effects advance hook stashes.
	 */
	committing: boolean
}

/** Returned by registerReactSignals(): tears the registration down. */
export interface ReactSignalsHandle {
	/** Remove the engine hooks installed by {@link registerReactSignals}. */
	dispose(): void
}

const rootConnections = new Set<ReactRootConnection>()
interface HostedDraft {
	draft: Draft
	/**
	 * The React transition object that owns this draft. Late deliveries
	 * restore it so their dispatches join the original transition's
	 * updates.
	 */
	owner: object | null
	/**
	 * Root connections that received the draft and have not committed it;
	 * the draft retires when this empties.
	 */
	recipients: Set<ReactRootConnection>
	/**
	 * Every connection that received the draft at broadcast time. A root
	 * mounted later is absent, and its subscribers rely on the retirement
	 * fold notifying them, since none of their passes carried the draft.
	 */
	audience: Set<ReactRootConnection>
}

const hostedDrafts = new Map<DraftId, HostedDraft>()

let handle: ReactSignalsHandle | null = null

interface SharedInternals {
	H?: { useEffect?: unknown; useState?: unknown } | null
	T?: object | null
}

const reactInternals: SharedInternals =
	((React as unknown as Record<string, unknown>)[
		'__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'
	] as SharedInternals | undefined) ?? {}

/**
 * React parks a context-only dispatcher between renders. All of its hooks
 * point to the same invalid-hook function; live render dispatchers install
 * distinct implementations. This detects a render before the component
 * calls its first hook, which is required to reject an immediate signal
 * write without letting it mutate state first.
 */
function isRendering(): boolean {
	const H = reactInternals.H
	return H != null && H.useState !== H.useEffect
}

let rejectedRenderWrite = false

function renderWriteGuard(): void {
	if (isRendering() || rejectedRenderWrite) {
		if (!rejectedRenderWrite) {
			// React may call the component again outside its render dispatcher
			// while it builds the error stack. Keep rejecting writes through that
			// synchronous diagnostic replay so it cannot perform the mutation the
			// real render rejected.
			rejectedRenderWrite = true
			queueMicrotask(() => {
				rejectedRenderWrite = false
			})
		}
		const error = new Error(
			'cosignals: state was written during a React render. ' +
				'Render must be pure; move the write into an event handler or effect.',
		)
		trace?.emitEvent('policy-error', null, NO_EVENT, {
			error,
			phase: 'render-write',
		})
		throw error
	}
}

// ---------------------------------------------------------------------------
// Render-world notes: how a render pass declares which world it is.
// ---------------------------------------------------------------------------

/**
 * A render pass's own declaration of which world it is executing in:
 * written by the pass's CosignalsProvider render (whose reducer state
 * is the pass's world) and refreshed by every one of our hooks the pass
 * renders. Consumed by plain latest()/isPending() calls in render bodies, and by
 * hooks mounting inside the pass.
 *
 * The danger is a pass consuming a note some other pass wrote, so a note
 * is only valid for the pass that wrote or refreshed it. Enforced by
 * construction:
 * - a note dies when any render under a different connection record writes one
 *   (foreign roots overwrite or clear, never inherit);
 * - a note carrying live drafts dies at the end of the synchronous work
 *   chunk that wrote it. A microtask covers every path that unwinds the
 *   stack (event handlers, interleaved urgent flushes), and an
 *   immediate-priority scheduler task covers same-stack handoffs between
 *   React work-loop tasks, such as a suspended pass followed by another
 *   root's pass in one flush;
 * - consuming a note requires a live hooks dispatcher, i.e. a render body.
 * When no valid note exists during a render, reads fall back to base
 * state. Wrong-toward-base is the safe direction; serving a stale world,
 * or leaking drafts into an urgent pass, is never acceptable.
 */
interface RenderWorldNote {
	connection: ReactRootConnection | null
	ids: readonly DraftId[]
}

let note: RenderWorldNote | null = null

function expiryFor(mine: RenderWorldNote): () => void {
	return () => {
		if (note === mine) {
			note = null
		}
	}
}

function armNoteExpiry(mine: RenderWorldNote): void {
	const expire = expiryFor(mine)
	queueMicrotask(expire)
	// The scheduler's task queue is a min-heap on expiration: an immediate
	// task scheduled now runs before any waiting normal-priority render task,
	// even when the work loop continues in the same stack.
	try {
		Scheduler.unstable_scheduleCallback(Scheduler.unstable_ImmediatePriority, expire)
	} catch (error) {
		trace?.emitEvent('scheduler-fallback', null, NO_EVENT, {
			error,
			phase: 'render-note-expiry',
			root: mine.connection ?? undefined,
		})
		// No scheduler host (non-DOM test rigs): the microtask still covers
		// every path that unwinds the stack.
	}
}

/**
 * Called by the connection's own render: authoritative for its pass, always
 * overwrites. An empty world clears the note instead of installing one —
 * a null note already means base state to every consumer, and steady-
 * state renders stay allocation-free.
 */
export function noteRenderWorld(connection: ReactRootConnection, ids: readonly DraftId[]): void {
	if (ids.length === 0) {
		note = null
		return
	}
	if (note !== null && note.connection === connection && note.ids === ids) {
		return
	} // StrictMode re-render
	note = { connection, ids }
	armNoteExpiry(note)
}

/**
 * Called by every hook render: kills a foreign connection's leftover note,
 * and — when the hook carries world state of its own — re-establishes a
 * note for passes the connection itself did not render. The hook's ids come
 * from React's update queues for this very pass, so they can never run
 * ahead of it.
 */
export function noteHookRender(
	connection: ReactRootConnection | null,
	ids: readonly DraftId[] | null,
): void {
	if (note !== null && note.connection !== connection) {
		note = null
	}
	if (note === null && ids !== null && ids.length > 0) {
		note = { connection, ids }
		armNoteExpiry(note)
	}
}

/**
 * The valid note's ids for a connection, or null. Hooks resolve their render
 * value against this when present; it covers components mounting inside a
 * transition pass, whose own reducers never received the dispatch.
 */
export function renderPassIds(connection: ReactRootConnection | null): readonly DraftId[] | null {
	return note !== null && note.connection === connection ? note.ids : null
}

function renderWorldProvider(): readonly DraftId[] | 'base' | null {
	if (!isRendering()) {
		return null
	} // not rendering: ambient reads see the newest view
	return note === null ? 'base' : note.ids
}

// ---------------------------------------------------------------------------
// Draft wake dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a draft wake into a hook's reducer. At write time React's
 * ambient transition is already installed (the write ran inside
 * startTransition), so the dispatch joins its updates as-is. Corrections
 * after the fact — late subscriptions, appends delivered from plain
 * contexts — restore the owning transition object around the dispatch, so
 * the update still classifies as that transition's work instead of
 * landing synchronously, which would commit draft values into an urgent
 * frame.
 */
export function dispatchDraftWake(id: DraftId, dispatch: (id: DraftId) => void): void {
	if (reactInternals.T != null) {
		dispatch(id)
		return
	}
	const owner = hostedDrafts.get(id)?.owner
	if (owner == null) {
		dispatch(id)
		return
	}
	const prev = reactInternals.T
	reactInternals.T = owner
	try {
		dispatch(id)
	} finally {
		reactInternals.T = prev
	}
}

/**
 * Dispatch outside any ambient transition, so the update is scheduled
 * urgently rather than joining a transition. Mirrors React's own
 * useTransition, which schedules its isPending update before entering the
 * transition context — an indicator must not be held hostage by the very
 * transition it indicates.
 */
export function dispatchUrgent(dispatch: () => void): void {
	const prev = reactInternals.T
	if (prev == null) {
		dispatch()
		return
	}
	reactInternals.T = null
	try {
		dispatch()
	} finally {
		reactInternals.T = prev
	}
}

/**
 * A wake meaning "re-render against current state". Zero is never a
 * live draft id (they start at 1), so the reducer leaves it out of the id
 * set while still returning a fresh state object — producing a re-render
 * against whatever the queues say the world is now.
 */
export const REPAIR_WAKE: DraftId = 0

/**
 * What a hook last rendered: the world ids it resolved in and the value
 * it showed. Late-subscription repair (correctSubscription) and the
 * notify predicate (resolutionDiffers) compare current state against it.
 */
export interface RenderedResolution {
	ids: readonly DraftId[]
	value: unknown
	/** False until the hook's first completed render fills the stash. */
	live: boolean
}

/**
 * Late-subscription repair, run when a subscriber's engine subscription
 * attaches. React commits the subscription after the render that created
 * it, so writes can slip into that gap. Two kinds of gap are possible:
 * - a live draft carried by this subscriber's root never reached its
 *   reducer (the component mounted mid-transition): deliver the draft id
 *   inside the owning transition, so this subscriber converges with that
 *   root's commit. Roots outside the draft's audience stay on the
 *   committed world — their connection never carried the draft, matching how a
 *   newly created React root never holds another root's pending updates —
 *   and the retirement fold notifies their subscribers instead;
 * - base state moved past what this subscriber rendered (including a
 *   fold that completed in the gap): repair urgently.
 *
 * `deliver` is the hook's draft-wake channel: it dedupes against the ids
 * already dispatched since the hook's last render and restores the owning
 * transition around the dispatch. `dispatch` is the raw reducer, used for
 * the urgent repair bump.
 */
export function correctSubscription(
	node: ProducerNode,
	rendered: RenderedResolution,
	connection: ReactRootConnection,
	deliver: (id: DraftId, cause: TraceEventId) => void,
	dispatch: (id: DraftId) => void,
): void {
	for (const id of draftsAffecting(node)) {
		if (rendered.ids.includes(id)) {
			continue
		}
		const hosted = hostedDrafts.get(id)
		if (hosted === undefined || !hosted.audience.has(connection)) {
			continue
		}
		deliver(id, trace?.getDraftWrite(hosted.draft) ?? NO_EVENT)
	}
	if (resolutionDiffers(node, rendered)) {
		dispatch(REPAIR_WAKE)
	}
}

/**
 * Would re-rendering show this subscriber something different from what
 * it rendered? The comparison resolves in the world the subscriber
 * rendered (its own reducer ids), so activity in worlds the subscriber
 * does not carry compares equal. That per-subscriber compare
 * is what keeps a silent fold, a foreign transition's writes, and an
 * equality-cutoff wave from costing renders — with no global suppression
 * state anywhere.
 *
 * The async cases mirror the unwrap rule: an error is always news; a
 * suspension with settled history serves its stale value, so it wakes
 * the subscriber only when that stale value differs from what was
 * rendered; a never-settled suspension is always news, because the
 * subscriber must suspend.
 */
export function resolutionDiffers(node: ProducerNode, rendered: RenderedResolution): boolean {
	const st = resolveState(node, worldOf(rendered.ids))
	const asyncBits = st.flags & Flag.AsyncMask
	if (asyncBits === Flag.AsyncError) {
		return true
	}
	if (asyncBits === Flag.AsyncSuspended && isUninitialized(st.value)) {
		return true
	}
	return !Object.is(st.value, rendered.value)
}

// ---------------------------------------------------------------------------
// Draft broadcast and per-root commit bookkeeping
// ---------------------------------------------------------------------------

/**
 * Drafts created for React transition contexts, including the convenience
 * helpers. The values are Draft records, not ids: an entry dies with its
 * transition object (WeakMap), and handing the record straight to write
 * classification spares every drafted write an id lookup.
 */
const draftsByTransition = new WeakMap<object, Draft>()

function ambientClassifier(): Draft | null {
	const T = reactInternals.T
	if (T == null) {
		return null
	}
	let draft = draftsByTransition.get(T)
	if (draft === undefined) {
		draft = openDraft()
		draftsByTransition.set(T, draft)
		broadcastDraft(draft)
	}
	// A retired or discarded draft classifies as urgent: its effects are
	// already folded into base state or rolled back, so a late write under
	// the same transition object must be a plain base-state write, never
	// an append to a finished batch.
	return draft.state === 'open' ? draft : null
}

/**
 * Send a new draft's id to every connection, dispatched inside the current
 * React context so the updates join the transition. Connections are the only
 * broadcast audience: value subscribers are woken per drafted atom
 * instead (see dispatchDraftWake), so a transition re-renders each root's
 * connection plus exactly the subscribers its writes touch.
 */
export function broadcastDraft(draft: Draft): void {
	// Prune finished drafts: an engine-side discard can finish a draft
	// without ever visiting the host's bookkeeping.
	for (const [id, hosted] of hostedDrafts) {
		if (hosted.draft.state !== 'open') {
			hostedDrafts.delete(id)
		}
	}
	const recipients = new Set(rootConnections)
	const hosted: HostedDraft = {
		draft,
		owner: reactInternals.T ?? null,
		recipients,
		audience: new Set(recipients),
	}
	hostedDrafts.set(draft.id, hosted)
	for (const connection of recipients) {
		connection.dispatch(draft.id)
	}
	if (recipients.size === 0) {
		// No mounted connection observes this draft, so nothing will ever commit
		// it; retire it as soon as the writing callback finishes. The microtask
		// keeps the retirement after any writes still being appended.
		queueMicrotask(() => {
			if (hostedDrafts.get(draft.id) === hosted && hosted.recipients.size === 0) {
				hostedDrafts.delete(draft.id)
				retireDraft(draft.id)
			}
		})
	}
}

export function registerRootConnection(connection: ReactRootConnection): () => void {
	rootConnections.add(connection)
	return () => {
		rootConnections.delete(connection)
		for (const [id, hosted] of hostedDrafts) {
			if (hosted.recipients.delete(connection) && hosted.recipients.size === 0) {
				hostedDrafts.delete(id)
				retireDraft(id)
			}
		}
	}
}

/** A root committed a render pass whose world contained these drafts. */
export function confirmRootCommit(
	connection: ReactRootConnection,
	ids: readonly DraftId[],
): void {
	connection.committing = true
	try {
		const sink = trace
		let commitEvent: TraceEventId = NO_EVENT
		if (sink !== null) {
			// The commit is caused by the committed draft's last write (its
			// open event when it never wrote), so the committed frame chains
			// back to the transition's origin instead of rooting itself.
			let commitCause: TraceEventId = NO_EVENT
			for (const id of ids) {
				const draft = hostedDrafts.get(id)?.draft
				if (draft !== undefined) {
					const lastWrite = sink.getDraftWrite(draft)
					commitCause = lastWrite !== NO_EVENT ? lastWrite : sink.getCause(draft)
				}
			}
			commitEvent = sink.emitEvent('transition-commit', null, commitCause, {
				root: connection,
				world: ids,
			})
		}
		// This root's committed view changed; poke the draft watchers of every
		// atom the committed drafts touched. This is cheap: value subscribers
		// bail through the notify predicate when their resolution is
		// unchanged. The poke carries the commit event, so a subscriber it
		// does re-render (one whose passes never carried the draft) traces
		// back through the commit to the transition's writes. All pokes run
		// before any retirement, because pokes can flush synchronously while
		// retirement folds state and starts its own notification wave.
		for (const id of ids) {
			const hosted = hostedDrafts.get(id)
			if (hosted === undefined || hosted.draft.state !== 'open') {
				continue
			}
			for (const atom of hosted.draft.atoms) {
				pokeDraftWatchers(atom, commitEvent)
			}
		}
		for (const id of ids) {
			const hosted = hostedDrafts.get(id)
			if (
				hosted !== undefined &&
				hosted.recipients.delete(connection) &&
				hosted.recipients.size === 0
			) {
				hostedDrafts.delete(id)
				// Every recipient committed: fold the draft into base state. The
				// fold's writes notify every subscriber over the touched atoms,
				// and each subscriber's render-notify predicate compares its
				// rendered value against the folded resolution. Subscribers whose
				// render passes carried the draft compare equal and stay quiet;
				// subscribers under a connection that never carried it (mounted
				// mid-transition) see the folded values as new and re-render.
				retireDraft(id)
			}
		}
	} finally {
		connection.committing = false
	}
}

// ---------------------------------------------------------------------------
// Deferred-effect hosting: each provider renders a last-child sentinel whose
// commit-phase effects drain the engine's deferred lanes (see
// DeferredEffectHost). A lane request becomes a reducer dispatch on every
// sentinel, at the same ambient priority as the subscriber wakes from the
// same write — so React batches them into one pass, and the drain runs in
// that pass's commit: the effect's DOM writes land in the same frame as the
// components' updates, never a frame ahead of them (the flaw of a raw
// microtask pump) and never a frame behind.
// ---------------------------------------------------------------------------

const effectHostWakes = new Set<() => void>()

function laneWakePump(): boolean {
	if (effectHostWakes.size === 0) {
		return false
	}
	for (const wake of effectHostWakes) {
		// Outside any ambient transition: a drain must not be held hostage by
		// the pending transition whose scope the triggering write ran in.
		dispatchUrgent(wake)
	}
	return true
}

/**
 * Register a sentinel's wake; the returned cleanup unregisters it and
 * re-arms the built-in pumps for requests this sentinel accepted but will
 * never commit.
 */
export function registerEffectHost(wake: () => void): () => void {
	effectHostWakes.add(wake)
	return () => {
		effectHostWakes.delete(wake)
		repumpDeferredLanes()
	}
}

/**
 * Install the bindings' hooks into the engine (write classification, the
 * write-during-render guard, the render-world provider, the deferred-lane
 * pumps). Idempotent per process.
 */
export function registerReactSignals(): ReactSignalsHandle {
	if (handle !== null) {
		return handle
	}
	setAmbientClassifier(ambientClassifier)
	setRenderWriteGuard(renderWriteGuard)
	setRenderWorldProvider(renderWorldProvider)
	setLanePump(laneWakePump)
	handle = {
		dispose() {
			if (handle === null) {
				return
			}
			setAmbientClassifier(null)
			setRenderWriteGuard(null)
			setRenderWorldProvider(null)
			setLanePump(null)
			repumpDeferredLanes()
			handle = null
		},
	}
	return handle
}

/** Test seam: engine reset plus host registry scrub. Keeps registration. */
export function resetReactSignalsForTest(): void {
	resetEngineForTest()
	rootConnections.clear()
	hostedDrafts.clear()
	effectHostWakes.clear()
	note = null
	rejectedRenderWrite = false
	if (handle !== null) {
		// resetEngineForTest cleared the engine hooks; re-arm them.
		setAmbientClassifier(ambientClassifier)
		setRenderWriteGuard(renderWriteGuard)
		setRenderWorldProvider(renderWorldProvider)
	}
}

declare const queueMicrotask: (fn: () => void) => void
