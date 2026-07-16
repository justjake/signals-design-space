/**
 * Drafts and worlds: how the engine participates in React transitions
 * without tearing.
 *
 * During a transition, React keeps the current tree on screen showing the
 * old state while it renders a work-in-progress tree with the transition's
 * updates applied. useState supports this because pending updates live in
 * per-hook queues, and each render pass chooses which queued updates to
 * apply. An external store has a single current value per atom, so every
 * render pass would see the same thing — a transition's writes would either
 * show up immediately (defeating the transition) or be invisible to the
 * work-in-progress render. This module gives atoms the same machinery React
 * gives useState: pending updates are stored beside the atom rather than in
 * it, and every reader declares which pending batches it wants to see.
 *
 * The model:
 *
 * - A draft is one transition batch. A write made inside a transition does
 *   not touch the cell; it appends an intent — either a set-value or an
 *   updater function — to that cell's rebase log, tagged with the draft.
 * - A rebase log exists per cell, only while some draft has written to it.
 *   It holds the value the cell had before the first drafted write
 *   (valueBeforeDrafts) plus every intent since, in dispatch order. Urgent
 *   (non-transition) writes to a logged cell update the cell's base value
 *   immediately as usual, and also append an intent, so drafted replays
 *   see them in order.
 * - A world is a set of drafts: the answer to "which pending batches does
 *   this reader include?". Each React render pass resolves values in the
 *   world matching its lanes; ordinary non-React reads use the empty
 *   world, meaning base state. A cell's value in a world is computed by
 *   starting from valueBeforeDrafts and replaying, in dispatch order,
 *   every intent whose draft the world includes. Urgent intents always
 *   replay.
 *
 * Replaying in dispatch order keeps interleaved urgent and transition
 * updates coherent — the same rule React applies to useState queues. Say a
 * counter holds 1, a transition dispatches `n => n + 2`, then an urgent
 * write dispatches `n => n * 2`. Base state replays only the urgent
 * intent: 1 * 2 = 2 shows on screen while the transition is pending. The
 * transition's world replays both in dispatch order: (1 + 2) * 2 = 6. The
 * transition's update composes with the urgent one instead of being
 * applied to a stale snapshot.
 *
 * Lifecycle: when React commits a transition, its draft is retired — the
 * full replay is folded into the cell through the normal write path
 * (equality check, propagation, effects), and the draft is marked retired
 * so render passes still holding its id resolve the same values they
 * already rendered. When a transition is abandoned, its draft is discarded:
 * its intents stop applying, and every subscriber that rendered them is
 * poked to re-render without them. When the last draft touching a cell
 * dies, the cell's log is deleted; when no drafts are live at all, all
 * per-world memo state is swept. A quiescent engine holds no transition
 * state anywhere.
 *
 * Reading order for this file: draft lifecycle and intent recording first,
 * then write classification (deciding whether a write belongs to a draft),
 * then world resolution (computing a node's value under a world, with
 * memoization), then the ambient views used outside renders.
 */

import {
	type Brand,
	type CellNode,
	type DerivedNode,
	type ReactiveNode,
	type TraceEventId,
	type GraphChangeClock,
	Flag,
	NO_EVENT,
	assertSignalReadAllowed,
	currentBaseChange,
	currentCause,
	currentGraphChange,
	dependencyOf,
	ensureFresh,
	ensureNodeRecord,
	isUninitialized,
	nextDependency,
	peekCell,
	pokeDraftWatchers,
	runUpdater,
	setActiveEvaluation,
	setCurrentCause,
	setHasLiveDrafts,
	startBatch,
	endBatch,
	tickGraphChange,
	emitEvent,
	startSpan,
	endSpan,
	untracked,
	writeCell,
} from './graph.ts'
import {
	type ResolvedState,
	ErrorBox,
	type Suspension,
	makeSuspension,
	trackThenable,
} from './asyncs.ts'

/**
 * Numeric identity of a draft. Ids start at 1 and are never reused, so
 * long-lived React state can hold an id without retaining the Draft
 * record behind it.
 */
export type DraftId = Brand<number, 'DraftId'>
/**
 * A draft is open until it is retired (committed into base state) or
 * discarded (rolled back).
 */
export type DraftState = 'open' | 'retired' | 'discarded'

/**
 * How an intent writes: 'set' replaces the cell's value, 'update'
 * applies an updater function to the previous value.
 */
export type OpKind = 'set' | 'update'

/**
 * Which drafts one read, render pass, or committed root can see. A
 * world is only a replay filter — not a copy of the graph, and not a
 * React lane.
 */
export interface World {
	/** Live drafts, in creation order. */
	drafts: readonly Draft[]
	/**
	 * Canonical key for this draft set (comma-joined ids in creation
	 * order); memos are stored per (node, sig).
	 */
	sig: string
}

/** The empty world: no drafts, so every cell resolves to base state. */
export const BASE_WORLD: World = { drafts: [], sig: '' }

/** One recorded write: a set-value or an updater function. */
export interface Intent {
	kind: OpKind
	payload: unknown
	/** The draft that issued this intent; null for urgent intents. */
	draft: Draft | null
}

/** A cell's pending-write history (see the header). */
export interface RebaseLog {
	/** The cell's value when the first draft intent arrived. */
	valueBeforeDrafts: unknown
	/** All intents since, in dispatch order. */
	intents: Intent[]
}

/**
 * One transition batch: its identity, lifecycle state, and the cells it
 * wrote (see the header).
 */
export interface Draft {
	id: DraftId
	state: DraftState
	/**
	 * The graph clock reading when this draft opened, if it opened as the
	 * only live draft; zero otherwise. Used by the write-time value cutoff,
	 * which is only sound for a lone draft — overlap zeroes this on every
	 * live draft, permanently disabling the cutoff for them.
	 */
	cutoffAtGraphChange: GraphChangeClock
	/**
	 * A stable world containing just this draft, shared by the
	 * notification cutoff and by ambient latest() reads when this is the
	 * only live draft.
	 */
	world: World
	/**
	 * Cells this draft wrote; used by retirement, discard, and log
	 * teardown.
	 */
	cells: Set<CellNode<unknown>>
	openEvent: TraceEventId
	lastWriteEvent: TraceEventId
}

let nextDraftId: DraftId = 1
/** Open drafts, in creation order (Map preserves insertion). */
const liveDrafts = new Map<DraftId, Draft>()
// Detached cells may sit in world certificates; the graph asks before taking
// its recordless write fast path (see writeCell).
setHasLiveDrafts(() => liveDrafts.size > 0)
/** Cells with at least one live draft intent. */
const rebaseLogs = new Map<CellNode<unknown>, RebaseLog>()
/**
 * Per-cell draft revision: the clock reading at the cell's last
 * draft-related change (drafted or urgent intent append, retire,
 * discard). The base-value plane has changedAtGraphChange; this is the
 * overlay plane's stamp of the same clock. Weak so a deleted log's cell
 * retains nothing.
 */
const draftRevisionByCell = new WeakMap<CellNode<unknown>, GraphChangeClock>()
/** Nodes currently holding world memos, so quiescence can sweep them. */
const memoNodes = new Set<ReactiveNode>()
/**
 * Set only for the duration of the synchronous single-draft poke, so the
 * stable changedInCutoffWorld callback can see which world to compare
 * without allocating a closure per intent.
 */
let cutoffWorld: World | null = null

export function liveDraftCount(): number {
	return liveDrafts.size
}

export function openDraft(): Draft {
	const id = nextDraftId++
	const drafts: Draft[] = []
	const alone = liveDrafts.size === 0
	if (!alone) {
		for (const live of liveDrafts.values()) {
			live.cutoffAtGraphChange = 0
		}
	}
	const draft: Draft = {
		id,
		state: 'open',
		cutoffAtGraphChange: alone ? currentGraphChange() : 0,
		world: { drafts, sig: String(id) },
		cells: new Set(),
		openEvent:
			emitEvent !== null ? emitEvent('transition-open', null, NO_EVENT, { draftId: id }) : NO_EVENT,
		lastWriteEvent: NO_EVENT,
	}
	drafts.push(draft)
	liveDrafts.set(draft.id, draft)
	tickGraphChange()
	return draft
}

/**
 * Record a drafted write. The cell's base value does not move. Draft
 * watchers (isPending probes, latest() viewers) are poked, and subscribers
 * of the cell — and of watched computeds over it — additionally receive
 * the draft id through their draft-wake callback, so exactly the affected
 * components join the transition's render passes.
 */
export function appendDraftIntent(
	draft: Draft,
	cell: CellNode<unknown>,
	kind: OpKind,
	payload: unknown,
): void {
	if (draft.state !== 'open') {
		throw new Error('cannot write into a batch that already ended')
	}
	let log = rebaseLogs.get(cell)
	if (log === undefined) {
		// Capture the value before any drafted intent. peekCell runs a lazy
		// cell's initializer, which replay needs for its starting value.
		log = { valueBeforeDrafts: peekCell(cell), intents: [] }
		rebaseLogs.set(cell, log)
	}
	// Array order is dispatch order; retirement flips visibility, never
	// position.
	log.intents.push({ kind, payload, draft })
	draft.cells.add(cell)
	draftRevisionByCell.set(cell, tickGraphChange())
	let cause: TraceEventId = NO_EVENT
	if (emitEvent !== null) {
		cause = draft.lastWriteEvent = emitEvent(kind, cell, draft.openEvent, {
			draftId: draft.id,
		})
		// The cause lands in the record's side column; a detached cell needs a
		// real record first (an attached tracer forces the full write path
		// anyway, so this is consistent with writeCell).
		ensureNodeRecord(cell)
		cell.causeEvent = cause
	}
	if (draft.cutoffAtGraphChange !== 0 && draft.cutoffAtGraphChange >= currentBaseChange()) {
		cutoffWorld = draft.world
		try {
			pokeDraftWatchers(cell, cause, draft.id, changedInCutoffWorld)
		} finally {
			cutoffWorld = null
		}
	} else {
		pokeDraftWatchers(cell, cause, draft.id)
	}
}

/**
 * Record an urgent write on a cell that currently has a rebase log, so
 * pending worlds replay it in dispatch order. The base-state write itself
 * is performed by the caller. Returns false when the cell has no log.
 */
export function appendUrgentIntent(
	cell: CellNode<unknown>,
	kind: OpKind,
	payload: unknown,
): boolean {
	const log = rebaseLogs.get(cell)
	if (log === undefined) {
		return false
	}
	// Array order is dispatch order; retirement flips visibility, never
	// position.
	log.intents.push({ kind, payload, draft: null })
	draftRevisionByCell.set(cell, tickGraphChange())
	return true
}

/**
 * Handle the case where an urgent write to a drafted cell was an
 * equality no-op for base state. No wave propagated — yet the drafted
 * replays did change, because the urgent intent now sits after the draft's
 * intents in the log and the combined replay can land on a different
 * value. Each live draft's audience must be poked and woken, or its
 * transition would commit the pre-rebase value. When the urgent write does
 * change base state, none of this is needed: the wave re-renders
 * subscribers urgently, and React restarts in-progress transition work
 * after an interleaved urgent commit, so those passes re-resolve their
 * worlds fresh.
 */
export function pokeRebasedCell(cell: CellNode<unknown>): void {
	const log = rebaseLogs.get(cell)
	if (log === undefined) {
		return
	}
	let woken: Set<Draft> | null = null
	for (const intent of log.intents) {
		const d = intent.draft
		if (d === null || d.state !== 'open') {
			continue
		}
		if (woken === null) {
			woken = new Set()
		} else if (woken.has(d)) {
			continue
		}
		woken.add(d)
		pokeDraftWatchers(cell, NO_EVENT, d.id)
	}
}

/**
 * Replay a cell's log for a world, or for base state when `world` is
 * null. Urgent and retired intents always apply; drafted intents apply
 * only when the world includes their draft.
 */
function replayLog(cell: CellNode<unknown>, world: World | null): unknown {
	const log = rebaseLogs.get(cell)
	if (log === undefined) {
		return peekCell(cell)
	}
	let value = log.valueBeforeDrafts
	for (const intent of log.intents) {
		const d = intent.draft
		const included =
			d === null || d.state === 'retired' || (world !== null && world.drafts.includes(d))
		if (!included) {
			continue
		}
		value = applyIntent(cell, value, intent)
	}
	return value
}

/**
 * Apply one intent to a value; shared by world replay and by the
 * dead-prefix folding in releaseDraft.
 */
function applyIntent(cell: CellNode<unknown>, value: unknown, intent: Intent): unknown {
	let next = intent.payload
	if (intent.kind === 'update') {
		try {
			next = runUpdater(intent.payload as (p: unknown) => unknown, value)
		} catch (error) {
			// A single-draft cutoff is advisory and swallows this replay below.
			// Ordinary reads and retirement propagate it, so only those observed
			// callback failures enter the trace.
			if (cutoffWorld === null && emitEvent !== null) {
				emitEvent('callback-error', cell, currentCause, { error, phase: 'updater' })
			}
			throw error
		}
	}
	return cell.equals(value, next) ? value : next
}

/**
 * Commit a draft: fold its replay into base state through the normal
 * write path, then mark it retired so render passes still holding its id
 * resolve the same values.
 *
 * Whether a subscriber re-renders is decided per subscriber, not here:
 * the React layer compares what each subscriber rendered against what it
 * would resolve now. A subscriber whose render passes already showed the
 * draft's values compares equal and stays quiet; one that never carried
 * the draft sees the folded values as new and re-renders.
 */
export function retireDraft(id: DraftId): void {
	const draft = liveDrafts.get(id)
	if (draft === undefined) {
		return
	}
	liveDrafts.delete(id)
	draft.state = 'retired'
	tickGraphChange()
	const evt =
		emitEvent !== null
			? emitEvent(
					'transition-retire',
					null,
					draft.lastWriteEvent !== NO_EVENT ? draft.lastWriteEvent : draft.openEvent,
					{ draftId: id },
				)
			: NO_EVENT
	const prevCause = setCurrentCause(evt)
	try {
		startBatch()
		try {
			for (const cell of draft.cells) {
				draftRevisionByCell.set(cell, currentGraphChange())
				// The draft is already marked retired, so this base-state
				// replay includes its intents, interleaved with urgent ones in
				// dispatch order.
				writeCell(cell, replayLog(cell, null))
				pokeDraftWatchers(cell, evt)
			}
		} finally {
			endBatch()
		}
	} finally {
		setCurrentCause(prevCause)
	}
	releaseDraft(draft)
}

/**
 * Roll back an abandoned draft. The poke reaches every subscriber over
 * the draft's cells; those that rendered the draft's values now resolve
 * base values, compare different, and re-render without them.
 */
export function discardDraft(id: DraftId): void {
	const draft = liveDrafts.get(id)
	if (draft === undefined) {
		return
	}
	liveDrafts.delete(id)
	draft.state = 'discarded'
	tickGraphChange()
	const evt =
		emitEvent !== null
			? emitEvent('transition-discard', null, draft.openEvent, { draftId: id })
			: NO_EVENT
	for (const cell of draft.cells) {
		draftRevisionByCell.set(cell, currentGraphChange())
		pokeDraftWatchers(cell, evt)
	}
	releaseDraft(draft)
}

/**
 * Release a dead draft's logs and, when no live drafts remain, clear all
 * remaining logs and world memos. A log whose intents are all dead is deleted.
 * Otherwise its leading run of dead intents is folded into
 * valueBeforeDrafts so logs stay bounded. Folding must stop at the first
 * live intent: intents after it may be updater functions whose results
 * depend on that intent's world-specific value.
 */
function releaseDraft(dead: Draft): void {
	for (const cell of dead.cells) {
		const log = rebaseLogs.get(cell)
		if (log === undefined) {
			continue
		}
		const intents = log.intents
		let value = log.valueBeforeDrafts
		let prefix = 0
		for (; prefix < intents.length; prefix++) {
			const intent = intents[prefix]
			const draft = intent.draft
			if (draft !== null && draft.state !== 'retired' && draft.state !== 'discarded') {
				break
			}
			if (draft === null || draft.state === 'retired') {
				value = applyIntent(cell, value, intent)
			}
		}
		if (prefix === intents.length) {
			rebaseLogs.delete(cell)
		} else if (prefix !== 0) {
			log.valueBeforeDrafts = value
			intents.copyWithin(0, prefix)
			intents.length -= prefix
		}
	}
	if (liveDrafts.size > 0) {
		return
	}
	rebaseLogs.clear()
	for (const node of memoNodes) {
		node.worldMemos = null
	}
	memoNodes.clear()
}

/** @internal Test seam for the bounded-history invariant. */
export function rebaseLogIntentCount<T>(cell: CellNode<T>): number {
	return rebaseLogs.get(cell as CellNode<unknown>)?.intents.length ?? 0
}

/**
 * True while the draft is open. Retired and discarded ids are dead: their
 * effects are already folded into base state or rolled back.
 */
export function isLiveDraft(id: DraftId): boolean {
	return liveDrafts.has(id)
}

const NO_IDS: readonly DraftId[] = []

/**
 * Live drafts holding intents against this node's source cells (the node
 * itself for a cell; its transitive dependency cells for a computed). Used
 * for late-subscription repair: a subscriber that mounted after the
 * write-time wakes asks which transitions it missed.
 */
export function draftsAffecting(node: ReactiveNode): readonly DraftId[] {
	if (liveDrafts.size === 0) {
		return NO_IDS
	}
	// Set iteration observes in-loop adds, so this is an iterative closure
	// walk with the set itself as the visited test.
	const sources = new Set<ReactiveNode>()
	sources.add(node)
	for (const source of sources) {
		if ((source.flags & Flag.KindCell) !== 0) {
			continue
		}
		for (let l = source.deps; l !== undefined; l = nextDependency(l)) {
			sources.add(dependencyOf(l))
		}
	}
	const out: DraftId[] = []
	for (const [id, draft] of liveDrafts) {
		for (const cell of draft.cells) {
			if (sources.has(cell)) {
				out.push(id)
				break
			}
		}
	}
	return out
}

/** True while some live draft holds intents against this cell. */
export function cellHasDraftIntents(cell: CellNode<unknown>): boolean {
	const log = rebaseLogs.get(cell)
	if (log === undefined) {
		return false
	}
	for (const intent of log.intents) {
		const d = intent.draft
		if (d !== null && d.state !== 'retired' && d.state !== 'discarded') {
			return true
		}
	}
	return false
}

/** Test/reset seam: discard every live draft and clear per-suspension state. */
export function discardAllDrafts(): void {
	for (const id of [...liveDrafts.keys()]) {
		discardDraft(id)
	}
}

// ---------------------------------------------------------------------------
// Write classification: deciding whether a write happening right now
// belongs to a draft or to base state.
// ---------------------------------------------------------------------------

/**
 * Explicit write target used by engine tests and non-React integrations.
 * It affects write classification only; reads remain in their current
 * world (normally base state).
 */
let currentDraftWriteTarget: Draft | null = null
/**
 * Installed by the React bindings: detects writes issued inside the
 * current React transition context.
 */
let ambientClassifier: (() => Draft | null) | null = null

export function setAmbientClassifier(fn: (() => Draft | null) | null): void {
	ambientClassifier = fn
}

export function runWithDraftWrites<T>(draft: Draft, fn: () => T): T {
	const prev = currentDraftWriteTarget
	currentDraftWriteTarget = draft
	try {
		return fn()
	} finally {
		currentDraftWriteTarget = prev
	}
}

export function classifyWrite(): Draft | null {
	if (currentDraftWriteTarget !== null) {
		return currentDraftWriteTarget
	}
	if (ambientClassifier !== null) {
		return ambientClassifier()
	}
	return null
}

// ---------------------------------------------------------------------------
// World resolution: computing a node's value as seen by a world.
// ---------------------------------------------------------------------------

/** The world an evaluation is running in; null means base state. */
let currentWorld: World | null = null

export function getCurrentWorld(): World | null {
	return currentWorld
}

export function withWorld<T>(world: World | null, fn: () => T): T {
	const prev = currentWorld
	currentWorld = world
	try {
		return fn()
	} finally {
		currentWorld = prev
	}
}

/**
 * World objects keyed by id-array identity. React state arrays are
 * stable across renders, so repeated resolves of the same pass hit the
 * cache and allocate nothing.
 */
const worldCache = new WeakMap<
	readonly DraftId[],
	{ validAtGraphChange: GraphChangeClock; world: World }
>()

export function worldOf(ids: readonly DraftId[]): World {
	if (ids.length === 0) {
		return BASE_WORLD
	}
	const hit = worldCache.get(ids)
	if (hit !== undefined) {
		if (hit.validAtGraphChange === currentGraphChange()) {
			return hit.world
		}
		let live = true
		for (const draft of hit.world.drafts) {
			if (!liveDrafts.has(draft.id)) {
				live = false
				break
			}
		}
		if (live) {
			hit.validAtGraphChange = currentGraphChange()
			return hit.world
		}
	}
	// Normalize the id set React handed us: dead drafts drop out, and Map
	// iteration restores creation order regardless of dispatch arrival
	// order.
	const drafts: Draft[] = []
	let sig = ''
	for (const [id, draft] of liveDrafts) {
		if (ids.includes(id)) {
			drafts.push(draft)
			sig = sig === '' ? String(id) : `${sig},${id}`
		}
	}
	const world = drafts.length === 0 ? BASE_WORLD : { drafts, sig }
	worldCache.set(ids, { validAtGraphChange: currentGraphChange(), world })
	return world
}

// Draft-world evaluations run outside the graph's normal dependency
// tracking, so their memos need their own staleness evidence. While a
// memo evaluates, it collects a certificate: the list of sources it read,
// each with the clock readings observed at read time. A memo is valid
// later if every certified source still carries the same readings.

interface CertificateEntry {
	node: ReactiveNode | null
	changedAtGraphChange: GraphChangeClock
	draftRevision: GraphChangeClock
}

interface Certificate {
	entries: CertificateEntry[]
	count: number
}

/** One memoized resolution of a node under one world signature. */
interface WorldMemo {
	/**
	 * The clock reading at the last validation; while it still matches the
	 * current clock, the memo is fresh with no further checking. Draft
	 * activity and settlement tick the same clock as base writes, so one
	 * comparison covers every invalidation source.
	 */
	validAtGraphChange: GraphChangeClock
	/**
	 * The node's own changedAt reading when the memo was made; a base-state
	 * change to the node invalidates the memo outright.
	 */
	nodeChangedAtGraphChange: GraphChangeClock
	certificate: Certificate
	state: ResolvedState
}

/**
 * The certificate being collected by the draft-world evaluation in
 * progress. Entry arrays and objects are reused when a memo re-evaluates.
 */
let activeCertificate: Certificate | null = null

function appendCertificate(
	node: ReactiveNode,
	changedAtGraphChange: GraphChangeClock,
	draftRevision: GraphChangeClock,
): void {
	const certificate = activeCertificate
	if (certificate === null) {
		return
	}
	const count = certificate.count
	if (count !== 0 && certificate.entries[count - 1]?.node === node) {
		return
	}
	let entry = certificate.entries[count]
	if (entry === undefined) {
		entry = { node, changedAtGraphChange, draftRevision }
		certificate.entries[count] = entry
	} else {
		entry.node = node
		entry.changedAtGraphChange = changedAtGraphChange
		entry.draftRevision = draftRevision
	}
	certificate.count = count + 1
}

function recordSource(node: ReactiveNode): void {
	const draftRevision =
		(node.flags & Flag.KindCell) !== 0
			? (draftRevisionByCell.get(node as CellNode<unknown>) ?? 0)
			: 0
	appendCertificate(node, node.changedAtGraphChange, draftRevision)
}

function inheritCertificate(certificate: Certificate): void {
	for (let i = 0; i < certificate.count; i++) {
		const entry = certificate.entries[i]
		appendCertificate(entry.node as ReactiveNode, entry.changedAtGraphChange, entry.draftRevision)
	}
}

function clearInactiveCertificateEntries(certificate: Certificate, previousCount: number): void {
	for (let i = certificate.count; i < previousCount; i++) {
		const entry = certificate.entries[i]
		entry.node = null
	}
}

function memoFor(node: ReactiveNode, sig: string): WorldMemo | undefined {
	return node.worldMemos?.get(sig) as WorldMemo | undefined
}

/** Passive view of a world memo's state: no evaluation, no validation. */
export function peekWorldMemo(node: ReactiveNode, sig: string): ResolvedState | undefined {
	return memoFor(node, sig)?.state
}

function memoValid(node: ReactiveNode, memo: WorldMemo): boolean {
	const graphChange = currentGraphChange()
	if (memo.validAtGraphChange === graphChange) {
		return true
	}
	if (memo.nodeChangedAtGraphChange !== node.changedAtGraphChange) {
		return false
	}
	if (
		(memo.state.flags & Flag.AsyncSuspended) !== 0 &&
		(memo.state.throwable as Suspension).resolve === null
	) {
		return false
	}
	for (let i = 0; i < memo.certificate.count; i++) {
		const entry = memo.certificate.entries[i]
		const source = entry.node as ReactiveNode
		if (source.changedAtGraphChange !== entry.changedAtGraphChange) {
			return false
		}
		if (
			(source.flags & Flag.KindCell) !== 0 &&
			(draftRevisionByCell.get(source as CellNode<unknown>) ?? 0) !== entry.draftRevision
		) {
			return false
		}
	}
	memo.validAtGraphChange = graphChange
	return true
}

/**
 * Whether two resolutions are indistinguishable to a reader: same async
 * state, and equal values under the node's own equality function.
 */
function statesEqual(node: ReactiveNode, left: ResolvedState, right: ResolvedState): boolean {
	const asyncBits = right.flags & Flag.AsyncMask
	if ((left.flags & Flag.AsyncMask) !== asyncBits) {
		return false
	}
	if (asyncBits === 0) {
		const equals = (node as DerivedNode<unknown>).equals ?? Object.is
		return equals(left.value, right.value)
	}
	if (asyncBits === Flag.AsyncSuspended) {
		return left.throwable === right.throwable && left.value === right.value
	}
	return (left.throwable as ErrorBox).error === (right.throwable as ErrorBox).error
}

/**
 * While exactly one draft is live, the poke walk applies a value
 * cutoff: for each node it reaches, compare the node's previous
 * resolution in the draft's world against a fresh one, and skip the
 * node's subscribers when they are equal. Before the draft first touched
 * the node, its world resolution is identical to base state.
 */
function changedInCutoffWorld(node: ReactiveNode): boolean {
	const world = cutoffWorld!
	try {
		const previous = memoFor(node, world.sig)?.state ?? resolveState(node, BASE_WORLD)
		const next = resolveState(node, world)
		return !statesEqual(node, previous, next)
	} catch {
		// The cutoff is advisory only. An updater that throws when replayed
		// should surface that error at an ordinary read site, not inside the
		// write that appended it — so treat it as changed and move on.
		return true
	}
}

/**
 * Resolve a node's value as seen by a world. For the base world this is
 * an ordinary graph read, and the node itself is returned as the state
 * view (nodes carry the ResolvedState shape), so nothing is allocated. For
 * a drafted world, cells replay their logs and computeds re-evaluate under
 * the world, with results memoized per (node, world signature).
 */
export function resolveState(node: ReactiveNode, world: World): ResolvedState {
	assertSignalReadAllowed()
	if ((node.flags & Flag.ComputingMask) !== 0) {
		throw new Error(`cycle detected in computed${node.label ? ` "${node.label}"` : ''}`)
	}
	if (world.drafts.length === 0) {
		if ((node.flags & Flag.KindCell) !== 0) {
			peekCell(node as CellNode<unknown>)
		} else {
			untracked(() => ensureFresh(node as DerivedNode<unknown>))
		}
		recordSource(node)
		return node as CellNode<unknown> | DerivedNode<unknown>
	}
	let memo = memoFor(node, world.sig)
	if (memo !== undefined && memoValid(node, memo)) {
		recordSource(node)
		inheritCertificate(memo.certificate)
		return memo.state
	}
	const certificate = memo?.certificate ?? { entries: [], count: 0 }
	let fresh: ResolvedState
	if ((node.flags & Flag.KindCell) !== 0) {
		const cell = node as CellNode<unknown>
		const previousCount = certificate.count
		let entry = certificate.entries[0]
		if (entry === undefined) {
			entry = {
				node: cell,
				changedAtGraphChange: cell.changedAtGraphChange,
				draftRevision: draftRevisionByCell.get(cell) ?? 0,
			}
			certificate.entries[0] = entry
		} else {
			entry.node = cell
			entry.changedAtGraphChange = cell.changedAtGraphChange
			entry.draftRevision = draftRevisionByCell.get(cell) ?? 0
		}
		certificate.count = 1
		clearInactiveCertificateEntries(certificate, previousCount)
		fresh = { flags: 0, value: replayLog(cell, world) }
	} else if (startSpan === null) {
		fresh = draftEvaluate(node as DerivedNode<unknown>, world, memo?.state, certificate)
	} else {
		const previousState = memo?.state
		const computeWorld: DraftId[] = []
		for (const draft of world.drafts) {
			computeWorld.push(draft.id)
		}
		const compute = startSpan('compute', node, node.causeEvent, { world: computeWorld })
		const prevCause = compute !== NO_EVENT ? setCurrentCause(compute) : NO_EVENT
		try {
			fresh = draftEvaluate(node as DerivedNode<unknown>, world, previousState, certificate)
		} finally {
			if (compute !== NO_EVENT) {
				setCurrentCause(prevCause)
			}
		}
		if (emitEvent !== null) {
			if ((fresh.flags & Flag.AsyncSuspended) !== 0) {
				emitEvent('compute-suspend', node, compute, {
					suspension: fresh.throwable as Suspension,
					world: computeWorld,
				})
			} else if ((fresh.flags & Flag.AsyncError) !== 0 && fresh !== previousState) {
				emitEvent('compute-error', node, compute, {
					error: (fresh.throwable as ErrorBox).error,
					world: computeWorld,
				})
			}
		}
		if (compute !== NO_EVENT && endSpan !== null) {
			endSpan(compute)
		}
	}
	// Keep the previous state record when the fresh resolution is
	// indistinguishable from it, so subscribers that compare by identity do
	// not re-render.
	const previousState = memo?.state
	const state =
		previousState !== undefined && statesEqual(node, previousState, fresh) ? previousState : fresh
	if (memo === undefined) {
		memo = {
			validAtGraphChange: currentGraphChange(),
			nodeChangedAtGraphChange: node.changedAtGraphChange,
			certificate,
			state,
		}
		if (node.worldMemos === null) {
			node.worldMemos = new Map()
			memoNodes.add(node)
		}
		node.worldMemos.set(world.sig, memo)
	} else {
		memo.validAtGraphChange = currentGraphChange()
		memo.nodeChangedAtGraphChange = node.changedAtGraphChange
		memo.state = state
	}
	recordSource(node)
	inheritCertificate(certificate)
	return state
}

/**
 * Resolve without adding this read to an enclosing draft-world computed's
 * dependency certificate. The target computed still collects its own
 * certificate if it must evaluate; only the caller's dependency is
 * suppressed.
 */
export function resolveStateUntracked(node: ReactiveNode, world: World): ResolvedState {
	const previous = activeCertificate
	activeCertificate = null
	try {
		return resolveState(node, world)
	} finally {
		activeCertificate = previous
	}
}

/**
 * Evaluate a computed's body under a world, without touching the node's
 * own cached value or dependency edges. Reads inside the body resolve the
 * same world (via withWorld) and record into the certificate.
 */
function draftEvaluate(
	node: DerivedNode<unknown>,
	world: World,
	prev: ResolvedState | undefined,
	certificate: Certificate,
): ResolvedState {
	// Reuse the previous pending span's suspension: Suspense retries must
	// observe one stable thenable per span.
	let suspension =
		prev !== undefined &&
		(prev.flags & Flag.AsyncSuspended) !== 0 &&
		(prev.throwable as Suspension).resolve !== null
			? (prev.throwable as Suspension)
			: null
	const worldUse = (t: PromiseLike<unknown>): unknown => {
		const box = trackThenable(t)
		if (box.status === 'fulfilled') {
			return box.result
		}
		if (box.status === 'rejected') {
			throw box.result
		}
		suspension ??= makeSuspension()
		box.parkedSuspensions!.add(suspension)
		throw WORLD_PARKED
	}
	const prevPark = currentPark
	const prevCertificate = activeCertificate
	const previousCertificateCount = certificate.count
	currentPark = worldUse
	activeCertificate = certificate
	certificate.count = 0
	// A draft evaluation runs untracked, so it can reach a derived that never
	// evaluated in base state; the flag write below needs a real record.
	ensureNodeRecord(node)
	node.flags |= Flag.DraftComputing
	const prevEvaluation = setActiveEvaluation(node)
	try {
		const previous = isUninitialized(node.value) ? undefined : node.value
		const value = untracked(() => withWorld(world, () => node.fn(worldUse as never, previous)))
		return { flags: 0, value }
	} catch (e) {
		if (e === WORLD_PARKED) {
			// The node's base value doubles as the stale value to serve; the
			// uninitialized sentinel means there is none yet.
			return { flags: Flag.AsyncSuspended, value: node.value, throwable: suspension! }
		}
		if (
			prev !== undefined &&
			(prev.flags & Flag.AsyncError) !== 0 &&
			(prev.throwable as ErrorBox).error === e
		) {
			return prev
		}
		return { flags: Flag.AsyncError, value: node.value, throwable: new ErrorBox(e) }
	} finally {
		clearInactiveCertificateEntries(certificate, previousCertificateCount)
		activeCertificate = prevCertificate
		currentPark = prevPark
		setActiveEvaluation(prevEvaluation)
		node.flags &= ~Flag.DraftComputing
	}
}

const WORLD_PARKED = Symbol('world-parked')

/**
 * The park function of the draft evaluation in progress, if any. Reads
 * of pending values inside that evaluation forward through it.
 */
export let currentPark: ((t: PromiseLike<unknown>) => unknown) | null = null

// ---------------------------------------------------------------------------
// Ambient views: worlds for reads happening outside any render pass.
// ---------------------------------------------------------------------------

/**
 * The world containing every live draft, in creation order — the newest
 * possible view of the data.
 */
export function latestWorld(): World {
	if (liveDrafts.size === 0) {
		return BASE_WORLD
	}
	if (liveDrafts.size === 1) {
		return liveDrafts.values().next().value!.world
	}
	const drafts = new Array<Draft>(liveDrafts.size)
	const ids = new Array<DraftId>(liveDrafts.size)
	let index = 0
	for (const draft of liveDrafts.values()) {
		drafts[index] = draft
		ids[index] = draft.id
		index++
	}
	return { drafts, sig: ids.join(',') }
}
