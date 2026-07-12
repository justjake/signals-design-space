/**
 * The React host: the glue between the engine's drafts/worlds and a
 * running React tree.
 *
 * The design premise is that React itself decides which render pass sees
 * which drafts. Draft ids are dispatched into ordinary React state (each
 * SignalScope's reducer, each useValue hook's reducer) from inside the
 * owning transition, so React's own update queues determine visibility:
 * urgent passes skip the pending update, the transition's passes include
 * it. The bindings never guess at lanes or patch React; everything runs
 * on stock React through public state and context primitives.
 *
 * This file contains, in order: render detection and the write-during-
 * render guard; the render-world note (how a render pass declares which
 * world it is); draft-wake dispatch and late-subscription repair; and the
 * registry that broadcasts new drafts to scopes and retires them when
 * every scope has committed.
 */
// The `scheduler` package ships untyped; the ambient declaration lives in
// scheduler.d.ts. The reference pulls it into any program that includes this
// file (external tools typecheck the adapter without the full src tree).
/// <reference path="./scheduler.d.ts" />
import * as React from 'react'
import * as Scheduler from 'scheduler'
import { Flag, isUninitialized, NO_EVENT, pokeDraftWatchers, type ReactiveNode } from '../graph.ts'
import {
	type Draft,
	type DraftId,
	draftsAffecting,
	openDraft,
	resolveState,
	retireDraft,
	setAmbientClassifier,
	setCommittedWorld,
	worldOf,
} from '../worlds.ts'
import { resetEngineForTest, setRenderWorldProvider, setRenderWriteGuard } from '../index.ts'

/** One registered SignalScope instance (one per root in practice). The
 * record is identity-stable for the scope's lifetime: it serves as the
 * ScopeContext value (so context changes never re-render consumers) and
 * as the key that render-world notes are validated against. */
export interface ProviderRecord {
	dispatch: (id: DraftId) => void
	container: object | null
}

export interface ReactSignalsHandle {
	/** Errors captured from user callbacks and React roots; tests assert []. */
	errors: unknown[]
	dispose(): void
}

const providers = new Set<ProviderRecord>()
interface HostedDraft {
	draft: Draft
	/** The React transition object that owns this draft. Late deliveries
	 * restore it so their dispatches join the original transition's
	 * updates. */
	owner: object | null
	/** Providers that received the draft and have not committed it yet;
	 * the draft retires when this empties. */
	recipients: Set<ProviderRecord>
	/** Every provider that received the draft at broadcast time. A scope
	 * mounted later is absent, and its subscribers rely on the retirement
	 * fold notifying them, since none of their passes carried the draft. */
	audience: Set<ProviderRecord>
}

const hostedDrafts = new Map<DraftId, HostedDraft>()

let handle: ReactSignalsHandle | null = null

interface SharedInternals {
	H?: object | null
	T?: object | null
}

function sharedInternals(): SharedInternals {
	const secret = (React as unknown as Record<string, unknown>)[
		'__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'
	]
	return (secret ?? {}) as SharedInternals
}

/** Hook dispatchers observed during renders. React exposes its current
 * hooks dispatcher in the internals object's H slot, but H is non-null
 * even between renders (React parks a context-only dispatcher there), so
 * "H is set" alone cannot detect rendering. Instead, dispatchers are
 * captured while one of our hooks is executing — which only happens
 * inside a component body — and membership in this set identifies a live
 * component render. Dispatchers are per-React-build singletons, so one
 * capture covers every later render. */
const renderDispatchers = new WeakSet<object>()

/** Record "we are rendering under this dispatcher" — called from every
 * scope and hook render. */
function captureRenderDispatcher(): void {
	const H = sharedInternals().H
	if (H != null) {
		renderDispatchers.add(H)
	}
}

/** True while React is executing a component render on this thread. */
function isRendering(): boolean {
	const H = sharedInternals().H
	return H != null && renderDispatchers.has(H)
}

function renderWriteGuard(): void {
	if (isRendering()) {
		throw new Error(
			'signals-royale-fx2: state was written during a React render. ' +
				'Render must be pure; move the write into an event handler or effect.',
		)
	}
}

// ---------------------------------------------------------------------------
// The render-world note: how a render pass declares which world it is.
// ---------------------------------------------------------------------------

/** The world of the render pass currently executing, as declared by that
 * pass itself: written by the pass's SignalScope render (whose reducer
 * state is the pass's world) and refreshed by every one of our hooks the
 * pass renders. Consumed by plain latest()/isPending() calls in render
 * bodies, and by hooks mounting inside the pass.
 *
 * The danger is a pass consuming a note some other pass wrote, so a note
 * is only valid for the pass that wrote or refreshed it. Enforced by
 * construction:
 * - a note dies when any render under a different scope record writes one
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
 * or leaking drafts into an urgent pass, is never acceptable. */
interface RenderWorldNote {
	scope: ProviderRecord | null
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
	} catch {
		// No scheduler host (non-DOM test rigs): the microtask still covers
		// every path that unwinds the stack.
	}
}

/** Called by the scope's own render: authoritative for its pass, always
 * overwrites. An empty world clears the note instead of installing one —
 * a null note already means base state to every consumer, and steady-
 * state renders stay allocation-free. */
export function noteRenderWorld(scope: ProviderRecord, ids: readonly DraftId[]): void {
	captureRenderDispatcher()
	if (ids.length === 0) {
		note = null
		return
	}
	if (note !== null && note.scope === scope && note.ids === ids) {
		return
	} // StrictMode re-render
	note = { scope, ids }
	armNoteExpiry(note)
}

/** Called by every hook render: kills a foreign scope's leftover note,
 * and — when the hook carries world state of its own — re-establishes a
 * note for passes the scope itself did not render. The hook's ids come
 * from React's update queues for this very pass, so they can never run
 * ahead of it. */
export function noteHookRender(scope: ProviderRecord | null, ids: readonly DraftId[] | null): void {
	captureRenderDispatcher()
	if (note !== null && note.scope !== scope) {
		note = null
	}
	if (note === null && ids !== null && ids.length > 0) {
		note = { scope, ids }
		armNoteExpiry(note)
	}
}

/** The valid note's ids for a scope, or null. Hooks resolve their render
 * value against this when present; it covers components mounting inside a
 * transition pass, whose own reducers never received the dispatch. */
export function renderPassIds(scope: ProviderRecord | null): readonly DraftId[] | null {
	return note !== null && note.scope === scope ? note.ids : null
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

/** Test-only counter of draft-wake dispatches that actually reached a
 * reducer (i.e. survived per-hook dedup). Nothing in the bindings reads
 * it. */
export const draftWakeStats = { dispatches: 0 }

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
	draftWakeStats.dispatches++
	const internals = sharedInternals()
	if (internals.T != null) {
		dispatch(id)
		return
	}
	const owner = hostedDrafts.get(id)?.owner
	if (owner == null) {
		dispatch(id)
		return
	}
	const prev = internals.T
	internals.T = owner
	try {
		dispatch(id)
	} finally {
		internals.T = prev
	}
}

/**
 * Dispatch outside any ambient transition, so the update is scheduled
 * urgently rather than joining a transition. Mirrors React's own
 * useTransition, which schedules its isPending update before entering the
 * transition scope — an indicator must not be held hostage by the very
 * transition it indicates.
 */
export function dispatchUrgent(dispatch: () => void): void {
	const internals = sharedInternals()
	const prev = internals.T
	if (prev == null) {
		dispatch()
		return
	}
	internals.T = null
	try {
		dispatch()
	} finally {
		internals.T = prev
	}
}

/** The repair wake: "re-render against current state". Zero is never a
 * live draft id (they start at 1), so the reducer leaves it out of the id
 * set while still returning a fresh state object — producing a re-render
 * against whatever the queues say the world is now. */
export const REPAIR_WAKE: DraftId = 0

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
 *   committed world — their scope never carried the draft, matching how a
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
	node: ReactiveNode,
	rendered: RenderedResolution,
	scope: ProviderRecord,
	deliver: (id: DraftId) => void,
	dispatch: (id: DraftId) => void,
): void {
	for (const id of draftsAffecting(node)) {
		if (rendered.ids.includes(id)) {
			continue
		}
		const hosted = hostedDrafts.get(id)
		if (hosted === undefined || !hosted.audience.has(scope)) {
			continue
		}
		deliver(id)
	}
	if (resolutionDiffers(node, rendered)) {
		dispatch(REPAIR_WAKE)
	}
}

/**
 * The render-notify predicate: would re-rendering show this subscriber
 * something different from what it rendered? It resolves in the world the
 * subscriber rendered (its own reducer ids), so activity in worlds the
 * subscriber does not carry compares equal. That per-subscriber compare
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
export function resolutionDiffers(node: ReactiveNode, rendered: RenderedResolution): boolean {
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

/** Drafts created for plain React.startTransition scopes (used without
 * our helper). The values are Draft records, not ids: an entry dies with
 * its transition object (WeakMap), and handing the record straight to
 * write classification spares every drafted write an id lookup. */
const draftsByTransition = new WeakMap<object, Draft>()

function ambientClassifier(): Draft | null {
	const T = sharedInternals().T
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
	return draft.state === 'open' || draft.state === 'sealed' ? draft : null
}

/** Send a new draft's id to every scope, dispatched inside the current
 * React context so the updates join the transition. Scopes are the only
 * broadcast audience: value subscribers are woken per drafted cell
 * instead (see dispatchDraftWake), so a transition re-renders each root's
 * scope plus exactly the subscribers its writes touch. */
export function broadcastDraft(draft: Draft): void {
	// Prune finished drafts: an engine-side discard can finish a draft
	// without ever visiting the host's bookkeeping.
	for (const [id, hosted] of hostedDrafts) {
		if (hosted.draft.state !== 'open' && hosted.draft.state !== 'sealed') {
			hostedDrafts.delete(id)
		}
	}
	const recipients = new Set(providers)
	const hosted: HostedDraft = {
		draft,
		owner: sharedInternals().T ?? null,
		recipients,
		audience: new Set(recipients),
	}
	hostedDrafts.set(draft.id, hosted)
	for (const p of recipients) {
		p.dispatch(draft.id)
	}
	if (recipients.size === 0) {
		// No mounted scope observes this draft, so nothing will ever commit
		// it; retire it as soon as the writing scope finishes. The microtask
		// keeps the retirement after any writes still being appended.
		queueMicrotask(() => {
			if (hostedDrafts.get(draft.id) === hosted && hosted.recipients.size === 0) {
				hostedDrafts.delete(draft.id)
				retireDraft(draft.id)
			}
		})
	}
}

export function registerProvider(p: ProviderRecord): () => void {
	providers.add(p)
	return () => {
		providers.delete(p)
		for (const [id, hosted] of hostedDrafts) {
			if (hosted.recipients.delete(p) && hosted.recipients.size === 0) {
				hostedDrafts.delete(id)
				retireDraft(id)
			}
		}
	}
}

/** A provider committed a render pass whose world contained these drafts. */
export function confirmCommit(p: ProviderRecord, ids: readonly DraftId[]): void {
	if (p.container !== null) {
		setCommittedWorld(p.container, ids)
	}
	// This root's committed view changed; poke the draft watchers of every
	// cell the committed drafts touched. This is cheap: value subscribers
	// bail through the notify predicate when their resolution is
	// unchanged. No engine event exists for a root commit, so the poke
	// carries no cause. All pokes run before any retirement, because pokes
	// can flush synchronously while retirement folds state and starts its
	// own notification wave.
	for (const id of ids) {
		const hosted = hostedDrafts.get(id)
		if (
			hosted === undefined ||
			(hosted.draft.state !== 'open' && hosted.draft.state !== 'sealed')
		) {
			continue
		}
		for (const cell of hosted.draft.cells) {
			pokeDraftWatchers(cell, NO_EVENT)
		}
	}
	for (const id of ids) {
		const hosted = hostedDrafts.get(id)
		if (
			hosted !== undefined &&
			hosted.recipients.delete(p) &&
			hosted.recipients.size === 0
		) {
			hostedDrafts.delete(id)
			// Every recipient committed: fold the draft into base state. The
			// fold's writes notify every subscriber over the touched cells,
			// and each subscriber's render-notify predicate compares its
			// rendered value against the folded resolution. Subscribers whose
			// render passes carried the draft compare equal and stay quiet;
			// subscribers under a scope that never carried it (mounted
			// mid-transition) see the folded values as new and re-render.
			retireDraft(id)
		}
	}
}

export function reportError(e: unknown): void {
	if (handle !== null) {
		handle.errors.push(e)
	}
}

/**
 * Install the bindings' hooks into the engine (write classification, the
 * write-during-render guard, the render-world provider). Idempotent per
 * process.
 */
export function registerReactSignals(): ReactSignalsHandle {
	if (handle !== null) {
		return handle
	}
	setAmbientClassifier(ambientClassifier)
	setRenderWriteGuard(renderWriteGuard)
	setRenderWorldProvider(renderWorldProvider)
	handle = {
		errors: [],
		dispose() {
			if (handle === null) {
				return
			}
			setAmbientClassifier(null)
			setRenderWriteGuard(null)
			setRenderWorldProvider(null)
			handle = null
		},
	}
	return handle
}

/** Test seam: engine reset plus host registry scrub. Keeps registration. */
export function resetReactSignalsForTest(): void {
	const wasRegistered = handle !== null
	resetEngineForTest()
	providers.clear()
	hostedDrafts.clear()
	note = null
	if (wasRegistered) {
		// resetEngineForTest cleared the engine hooks; re-arm them.
		setAmbientClassifier(ambientClassifier)
		setRenderWriteGuard(renderWriteGuard)
		setRenderWorldProvider(renderWorldProvider)
		handle!.errors.length = 0
	}
}

declare const queueMicrotask: (fn: () => void) => void
