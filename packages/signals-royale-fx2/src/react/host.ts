/**
 * The host seam: registration, the provider registry that carries
 * transition drafts into React state, write classification for plain
 * React.startTransition scopes, the write-during-render guard, the
 * validity-gated render-world note, and draft-lane wake dispatch.
 *
 * The design premise of this package: React itself is the world clock.
 * A transition draft becomes visible to a render pass only because that
 * pass's React state contains the draft id — and React's own update queues
 * decide which passes those are. The bindings never guess at lanes; they
 * read worlds out of React state. Everything runs on stock React.
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
	isLiveDraft,
	openDraft,
	resolveState,
	retireDraft,
	setAmbientClassifier,
	setCommittedWorld,
	worldOf,
} from '../worlds.ts'
import { resetEngineForTest, setRenderWorldProvider, setRenderWriteGuard } from '../index.ts'

/** One registered SignalScope instance (one per root in practice). The
 * record is identity-stable for the scope's lifetime: it is the ScopeContext
 * value (so context never re-renders consumers) and the key notes are
 * validity-checked against. */
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
/** Providers that received each draft's dispatch and have not committed it. */
const draftRecipients = new Map<DraftId, Set<ProviderRecord>>()
/** Everyone who EVER received each draft's dispatch. A scope mounted after
 * the broadcast is missing here: its passes never carried the draft, so a
 * silent fold would strand its subscribers — the retirement must be loud. */
const draftAudience = new Map<DraftId, Set<ProviderRecord>>()
/** The React transition object that owns each live draft. Late deliveries
 * (subscriber corrections, appends from plain contexts) restore it around
 * the dispatch so the update joins the owning transition's lanes. */
const draftOwners = new Map<DraftId, object>()

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

/** Hook dispatchers observed during renders. React parks a context-only
 * dispatcher in H between renders (non-null!), so "H is set" alone cannot
 * gate render detection; only dispatchers captured while an fx2 hook was
 * executing identify a live component render. Dispatchers are per-build
 * singletons, so one capture covers every later render. */
const renderDispatchers = new WeakSet<object>()

/** Record "we are rendering under this dispatcher" — called on every scope
 * and hook render (they only execute inside component bodies). */
function captureRenderDispatcher(): void {
	const H = sharedInternals().H
	if (H != null) renderDispatchers.add(H)
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
// The render-world note (validity-gated)
// ---------------------------------------------------------------------------

/** What the current render pass may see, as declared BY that pass: written
 * by the pass's SignalScope render (its reducer state is the pass world) and
 * refreshed by every fx2 hook the pass renders. Consumed by plain latest()/
 * isPending() calls in render bodies below, and by hooks mounting inside the
 * pass.
 *
 * Validity is the contract: a pass that did not refresh the note cannot
 * consume a stale one. Enforced by construction —
 * - the note dies when any render under a DIFFERENT scope record notes
 *   (foreign roots overwrite/clear, never inherit);
 * - a note carrying live drafts dies at the end of the synchronous work
 *   chunk that wrote it: a microtask covers stack unwinds (event handlers,
 *   interleaved urgent flushes), and an immediate-priority scheduler task
 *   covers same-stack handoffs between React work-loop tasks (a suspended
 *   pass followed by another root's pass in one flush);
 * - consumption requires a live hooks dispatcher (render bodies only).
 * When no valid note exists during a render, reads fall back to BASE —
 * wrong-toward-base is the safe direction; stale worlds and draft
 * leaks into urgent passes are never acceptable. */
interface RenderWorldNote {
	scope: ProviderRecord | null
	ids: readonly DraftId[]
}

let note: RenderWorldNote | null = null

function expiryFor(mine: RenderWorldNote): () => void {
	return () => {
		if (note === mine) note = null
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

/** The scope's own render: authoritative for its pass, always overwrites.
 * An empty world clears instead of installing — a null note already means
 * BASE to every consumer, and steady-state renders stay allocation-free. */
export function noteRenderWorld(scope: ProviderRecord, ids: readonly DraftId[]): void {
	captureRenderDispatcher()
	if (ids.length === 0) {
		note = null
		return
	}
	if (note !== null && note.scope === scope && note.ids === ids) return // StrictMode re-render
	note = { scope, ids }
	armNoteExpiry(note)
}

/** Every fx2 hook render: kills a foreign scope's leftovers, and (when the
 * hook carries world state of its own) re-establishes a note for passes the
 * scope itself did not render — the hook's ids come from React's update
 * queues for THIS pass, so they never run ahead of it. */
export function noteHookRender(scope: ProviderRecord | null, ids: readonly DraftId[] | null): void {
	captureRenderDispatcher()
	if (note !== null && note.scope !== scope) note = null
	if (note === null && ids !== null && ids.length > 0) {
		note = { scope, ids }
		armNoteExpiry(note)
	}
}

/** The valid note's ids for a scope, or null. Hooks resolve their render
 * value against this when present (it covers components mounting inside a
 * transition pass, whose own reducers never received the dispatch). */
export function renderPassIds(scope: ProviderRecord | null): readonly DraftId[] | null {
	return note !== null && note.scope === scope ? note.ids : null
}

function renderWorldProvider(): readonly DraftId[] | 'base' | null {
	if (!isRendering()) return null // ambient: newest intent
	return note === null ? 'base' : note.ids
}

// ---------------------------------------------------------------------------
// Draft ownership and wake dispatch
// ---------------------------------------------------------------------------

function rememberOwner(id: DraftId): void {
	// Sweep first so the map stays bounded by live drafts even when a draft
	// is discarded engine-side without host involvement.
	for (const known of [...draftOwners.keys()]) {
		if (!isLiveDraft(known)) draftOwners.delete(known)
	}
	const T = sharedInternals().T
	if (T != null) draftOwners.set(id, T)
}

/** Test-only counter of draft-lane dispatches that actually reached a
 * reducer (i.e. survived per-hook dedup). Nothing in the bindings reads it. */
export const draftWakeStats = { dispatches: 0 }

/**
 * Dispatch a draft-lane wake. At write time React's ambient transition is
 * already installed (the write ran inside startTransition), so the dispatch
 * rides its lanes as-is. Corrections after the fact — late subscriptions,
 * appends delivered from plain contexts — restore the OWNING transition
 * object around the dispatch, so the update still classifies as that
 * transition's work instead of landing synchronously (which would commit
 * draft values into an urgent frame).
 */
export function dispatchDraftWake(id: DraftId, dispatch: (id: DraftId) => void): void {
	draftWakeStats.dispatches++
	const internals = sharedInternals()
	if (internals.T != null) {
		dispatch(id)
		return
	}
	const owner = draftOwners.get(id)
	if (owner === undefined) {
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
 * Dispatch outside any ambient transition, so the update is scheduled with
 * the URGENT semantics of its call site rather than joining a transition.
 * Mirrors React's own useTransition, whose isPending update is scheduled
 * before the transition scope — an indicator must not be held hostage by
 * the very transition it indicates.
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

/** A repair wake: never a live draft id (draft ids start at 1), so the
 * reducer prunes it to a pure revision bump — an urgent re-render against
 * whatever the queues say the world is now. */
export const REPAIR_WAKE: DraftId = 0

interface RenderedResolution {
	ids: readonly DraftId[]
	value: unknown
	/** False until the hook's first completed render fills the stash. */
	live: boolean
}

/**
 * Late-subscription repair, run when a scoped subscriber's engine
 * subscription attaches (React commits it after the render that created
 * it). Two gaps are possible for a subscriber that was not yet subscribed
 * at write time:
 * - a LIVE draft carried by this subscriber's root never reached its
 *   reducer (a component mounted mid-transition) — join the owning
 *   transition so this subscriber converges with that root's commit.
 *   Roots OUTSIDE the draft's audience stay on the committed world: their
 *   scope never carried the draft (stock parity — a new root never holds
 *   another root's pending updates), and the retirement fold is loud for
 *   exactly that case;
 * - base state moved past what this subscriber rendered (including a fold
 *   that completed in the gap) — repair urgently.
 *
 * `deliver` is the hook's draft-lane channel: it dedupes against the ids
 * already dispatched since the hook's last render (a correction shares that
 * budget with write-time wakes) and restores the owning transition around
 * the dispatch. `dispatch` is the raw reducer for the urgent repair bump.
 */
export function correctSubscription(
	node: ReactiveNode,
	rendered: RenderedResolution,
	scope: ProviderRecord,
	deliver: (id: DraftId) => void,
	dispatch: (id: DraftId) => void,
): void {
	for (const id of draftsAffecting(node)) {
		if (rendered.ids.includes(id)) continue
		const audience = draftAudience.get(id)
		if (audience === undefined || !audience.has(scope)) continue
		deliver(id)
	}
	if (resolutionDiffers(node, rendered)) dispatch(REPAIR_WAKE)
}

/**
 * The render-notify predicate: would re-rendering show this subscriber
 * something different from what it rendered? Resolves in the world the
 * subscriber RENDERED (its own reducer ids), so speculative activity in
 * worlds it does not carry compares equal — that is what keeps a silent
 * fold, a foreign transition's writes, and an equality-cutoff wave from
 * costing renders, with no global suppression state anywhere.
 *
 * Async parity mirrors the unwrap rule: an error is always news; a
 * suspension with settled history serves its stale value, so it wakes only
 * when that stale value differs from what was rendered; a never-settled
 * suspension is always news (the subscriber must suspend).
 */
export function resolutionDiffers(node: ReactiveNode, rendered: RenderedResolution): boolean {
	const st = resolveState(node, worldOf(rendered.ids))
	const asyncBits = st.flags & Flag.AsyncMask
	if (asyncBits === Flag.AsyncError) return true
	if (asyncBits === Flag.AsyncSuspended) {
		if (isUninitialized(st.value)) return true
		return !Object.is(st.value, rendered.value)
	}
	return !Object.is(st.value, rendered.value)
}

// ---------------------------------------------------------------------------
// Draft broadcast and per-root commit bookkeeping
// ---------------------------------------------------------------------------

/** Drafts created for plain React.startTransition scopes (no helper). The
 * values are Draft RECORDS, not ids: an entry dies with its transition
 * object (WeakMap), and handing the record straight to write classification
 * spares every drafted write an id lookup. */
const draftsByTransition = new WeakMap<object, Draft>()

function ambientClassifier(): Draft | null {
	const T = sharedInternals().T
	if (T == null) return null
	let draft = draftsByTransition.get(T)
	if (draft === undefined) {
		draft = openDraft()
		draftsByTransition.set(T, draft)
		broadcastDraft(draft.id)
	}
	// A retired or discarded draft classifies as urgent (base state): its
	// effects are already folded or rolled back, so a late write under the same
	// transition object must be urgent, never an append to a finished batch.
	return draft.state === 'open' || draft.state === 'sealed' ? draft : null
}

/** Send a draft id to every scope, inside the current React context, so the
 * dispatches ride the transition's own lanes. Scopes are the only broadcast
 * audience: value subscribers are woken per drafted cell instead (see
 * dispatchDraftWake), so a transition re-renders each root's scope plus
 * exactly the subscribers its writes touch. */
export function broadcastDraft(id: DraftId): void {
	rememberOwner(id)
	const recipients = new Set(providers)
	draftRecipients.set(id, recipients)
	draftAudience.set(id, new Set(recipients))
	for (const p of recipients) p.dispatch(id)
	if (recipients.size === 0) {
		// No mounted scope observes this draft; it retires as soon as the
		// writing scope finishes (microtask keeps ops-append ordering).
		queueMicrotask(() => {
			if (draftRecipients.get(id)?.size === 0) {
				forgetDraft(id)
				retireDraft(id)
			}
		})
	}
}

function forgetDraft(id: DraftId): void {
	draftRecipients.delete(id)
	draftAudience.delete(id)
	draftOwners.delete(id)
}

export function registerProvider(p: ProviderRecord): () => void {
	providers.add(p)
	return () => {
		providers.delete(p)
		for (const [id, recipients] of draftRecipients) {
			recipients.delete(p)
			if (recipients.size === 0) {
				forgetDraft(id)
				retireDraft(id)
			}
		}
	}
}

/** A provider committed a render pass whose world contained these drafts. */
export function confirmCommit(p: ProviderRecord, ids: readonly DraftId[]): void {
	if (p.container !== null) setCommittedWorld(p.container, ids)
	// Per-root committed views changed; poke the draft watchers of every cell
	// the committed drafts touched (the useValue crowd bails via the notify
	// predicate when its resolution is unchanged, so this is cheap). No
	// engine event exists for a root commit, so the poke carries no cause.
	for (const draft of worldOf(ids).drafts) {
		for (const cell of draft.cells) pokeDraftWatchers(cell, NO_EVENT)
	}
	for (const id of ids) {
		const recipients = draftRecipients.get(id)
		if (recipients !== undefined && recipients.delete(p) && recipients.size === 0) {
			forgetDraft(id)
			// Fold loudness is per subscriber now: the fold's writes notify every
			// subscriber over the touched cells, and each one's render-notify
			// predicate compares its rendered value against the folded
			// resolution. Subscribers whose render passes carried the draft
			// compare equal and stay quiet; subscribers under a scope that never
			// carried it (mounted mid-transition) see the folded values as new
			// and re-render into them.
			retireDraft(id)
		}
	}
}

export function reportError(e: unknown): void {
	if (handle !== null) handle.errors.push(e)
}

/**
 * Register the bindings against the current React build. Stock React is the
 * only requirement: the bindings drive everything through public state and
 * context primitives. Idempotent per process.
 */
export function registerReactSignals(): ReactSignalsHandle {
	if (handle !== null) return handle
	setAmbientClassifier(ambientClassifier)
	setRenderWriteGuard(renderWriteGuard)
	setRenderWorldProvider(renderWorldProvider)
	handle = {
		errors: [],
		dispose() {
			if (handle === null) return
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
	draftRecipients.clear()
	draftAudience.clear()
	draftOwners.clear()
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
