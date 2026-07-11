/**
 * Worlds: draft overlays that make React transitions invisible to base-state
 * readers until they commit.
 *
 * A DRAFT is the engine-side record of one transition batch: write intents
 * (set values and update functions) against cells. A WORLD is "base state
 * plus an ordered set of drafts" — exactly what one React render pass is
 * allowed to see.
 *
 * Replay follows React's updater-queue rules. While any draft touches a
 * cell, the cell keeps a REBASE LOG: the value it held before the first
 * draft intent (valueBeforeDrafts) plus all intents in the order they were
 * dispatched (the intent array IS dispatch order). Views then differ only
 * in which intents they include:
 *
 * - base state = valueBeforeDrafts + urgent intents (drafts skipped, later
 *   urgents still apply — so a counter at 1 with a pending transition "+2"
 *   shows 2 after an urgent "*2");
 * - a world    = valueBeforeDrafts + urgent intents + its drafts' intents,
 *   all in dispatch order (the transition lands at (1+2)*2 = 6, never a
 *   reorder).
 *
 * Retiring a draft folds the full replay into base state through the
 * ordinary write path (effects, equality, propagation) and marks the draft
 * retired, so render passes still holding its id resolve identical values.
 * When the last draft touching a cell dies, the log is dropped — a
 * quiescent engine holds no per-suspension state anywhere.
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
	currentGraphChange,
	ensureFresh,
	isUninitialized,
	peekCell,
	pokeDraftWatchers,
	runUpdater,
	setActiveEvaluation,
	setCurrentCause,
	startBatch,
	endBatch,
	traceHook,
	untracked,
	writeCell,
} from './graph.ts'
import {
	type DerivedState,
	type ErrorBox,
	type Suspension,
	makeErrorBox,
	makeSuspension,
	setOnSettlement,
	trackThenable,
} from './asyncs.ts'

export type DraftId = Brand<number, 'DraftId'>
export type DraftState = 'open' | 'sealed' | 'retired' | 'discarded'
/** Monotone logical clock: ticks on any draft activity — opens, intents,
 * retires, discards, and thenable settlement (see setOnSettlement). World
 * memos and the world cache hold validAtDraftChange readings of it. */
export type DraftChangeClock = Brand<number, 'DraftChangeClock'>

export type OpKind = 'set' | 'update'

export interface Intent {
	kind: OpKind
	payload: unknown
	/** The draft that issued this intent; null for urgent intents. */
	draft: Draft | null
}

export interface RebaseLog {
	/** The cell's value when the first draft intent arrived. */
	valueBeforeDrafts: unknown
	intents: Intent[]
}

export interface Draft {
	id: DraftId
	state: DraftState
	/** The base clock at which this draft opened alone. Zero permanently
	 * disables producer-side wake cutoffs after overlap. */
	cutoffAtGraphChange: GraphChangeClock
	/** Stable single-draft world shared by the notification cutoff and ambient
	 * latest reads when this is the only live draft. */
	world: World
	/** Cells this draft wrote (for fold, poke, and log teardown). */
	cells: Set<CellNode<unknown>>
	openEvent: TraceEventId
	lastWriteEvent: TraceEventId
}

let nextDraftId: DraftId = 1
/** Open and sealed drafts, in creation order (Map preserves insertion). */
const liveDrafts = new Map<DraftId, Draft>()
/** Cells with at least one live draft intent. */
const rebaseLogs = new Map<CellNode<unknown>, RebaseLog>()
/** Per-cell replay revision. Weak and lazy: untouched cells pay nothing, and
 * certificates never retain deleted logs or their intent payloads. */
const draftRevisionByCell = new WeakMap<CellNode<unknown>, DraftChangeClock>()
let draftChangeClock: DraftChangeClock = 1
/** Nodes holding world memos, for sweeping at quiescence. */
const memoNodes = new Set<ReactiveNode>()
/** Per-root committed draft sets, recorded by the bindings at root commits. */
const committedWorlds = new WeakMap<object, readonly DraftId[]>()
/** Set only around the synchronous one-live-draft poke. The stable callback
 * avoids allocating one closure per intent. */
let cutoffWorld: World | null = null

setOnSettlement(() => {
	draftChangeClock++
})

export function currentDraftChange(): DraftChangeClock {
	return draftChangeClock
}

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
		openEvent: traceHook !== null ? traceHook('draft-open', null, NO_EVENT) : NO_EVENT,
		lastWriteEvent: NO_EVENT,
	}
	drafts.push(draft)
	liveDrafts.set(draft.id, draft)
	draftChangeClock++
	return draft
}

export function sealDraft(draft: Draft): void {
	if (draft.state === 'open') {
		draft.state = 'sealed'
	}
}

/** Record a drafted write intent. Draft watchers (isPending probes, latest()
 * viewers) get poked; base values do not move. Subscribers of the cell
 * — and of watched computeds over it — additionally receive the draft id on
 * their draft-lane channel, so exactly the affected components join the
 * transition's render passes (write-time dispatch runs inside the
 * transition scope; late appends re-dispatch to the same audience). */
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
		// Capture the value BEFORE any drafted intent; materializes lazy cells
		// (replay needs the starting value for the equality/update contract).
		log = { valueBeforeDrafts: peekCell(cell), intents: [] }
		rebaseLogs.set(cell, log)
	}
	// Array order is dispatch order; retirement flips visibility, never
	// position.
	log.intents.push({ kind, payload, draft })
	draft.cells.add(cell)
	draftChangeClock++
	draftRevisionByCell.set(cell, draftChangeClock)
	let cause: TraceEventId = NO_EVENT
	if (traceHook !== null) {
		cause = draft.lastWriteEvent = traceHook('write', cell, draft.openEvent, { draft: draft.id })
		cell.causeEvent = cause
	}
	if (draft.cutoffAtGraphChange === currentGraphChange()) {
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

/** Record an urgent intent on a cell that currently has a rebase log, so
 * pending worlds replay it in dispatch order. The base-state write itself is
 * performed by the caller. */
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
	draftChangeClock++
	draftRevisionByCell.set(cell, draftChangeClock)
	return true
}

/** An urgent intent on a drafted cell rebases every pending world over the
 * new base value. When the base-state write itself cuts off on equality,
 * nothing propagates — yet the drafted replays changed
 * (valueBeforeDrafts…draft…urgent lands differently than
 * valueBeforeDrafts…draft), so each live draft's audience must be
 * poked AND woken or its transition commits the pre-rebase value. The
 * changed-write path needs none of this: the wave re-renders subscribers
 * urgently, and React restarts in-progress transition work after an
 * interleaved urgent commit, so those passes re-resolve their worlds live. */
export function pokeRebasedCell(cell: CellNode<unknown>): void {
	const log = rebaseLogs.get(cell)
	if (log === undefined) {
		return
	}
	let woken: Set<Draft> | null = null
	for (const intent of log.intents) {
		const d = intent.draft
		if (d === null || (d.state !== 'open' && d.state !== 'sealed')) {
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

/** Replay a cell's log for a world (or for base state, when `world` is
 * null): urgent and retired intents always apply; drafted intents apply
 * only when the world includes their draft. */
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

/** The one intent-fold rule, shared by world replay and dead-prefix folding. */
function applyIntent(cell: CellNode<unknown>, value: unknown, intent: Intent): unknown {
	const next =
		intent.kind === 'set'
			? intent.payload
			: runUpdater(intent.payload as (p: unknown) => unknown, value)
	return cell.equals(value, next) ? value : next
}

/** Fold a draft into base state through the normal write path, then
 * let stale world sets resolve it as a no-op.
 *
 * There is no silent/loud switch here: whether a subscriber re-renders is
 * decided per subscriber by the render-notify predicate (the React layer
 * compares what it rendered against what it would resolve now). A
 * subscriber whose render passes already delivered the draft's values
 * compares equal and stays quiet; one that never carried the draft sees the
 * folded values as new and re-renders. */
export function retireDraft(id: DraftId): void {
	const draft = liveDrafts.get(id)
	if (draft === undefined) {
		return
	}
	liveDrafts.delete(id)
	draft.state = 'retired'
	draftChangeClock++
	const evt =
		traceHook !== null
			? traceHook(
					'draft-retire',
					null,
					draft.lastWriteEvent !== NO_EVENT ? draft.lastWriteEvent : draft.openEvent,
				)
			: NO_EVENT
	const prevCause = setCurrentCause(evt)
	try {
		startBatch()
		try {
			for (const cell of draft.cells) {
				draftRevisionByCell.set(cell, draftChangeClock)
				// The draft is marked retired, so the full committed replay
				// includes its intents interleaved with urgent ones in dispatch
				// order.
				writeCell(cell, replayLog(cell, null))
				pokeDraftWatchers(cell, evt)
			}
		} finally {
			endBatch()
		}
	} finally {
		setCurrentCause(prevCause)
	}
	releaseLogs(draft)
	maybeQuiesce()
}

/** Roll back an abandoned draft: anyone who saw it re-resolves without it.
 * The poke reaches every subscriber over the draft's cells; those that
 * rendered the draft's values now resolve base values, compare different,
 * and re-render — the rollback is new information no render pass shows. */
export function discardDraft(id: DraftId): void {
	const draft = liveDrafts.get(id)
	if (draft === undefined) {
		return
	}
	liveDrafts.delete(id)
	draft.state = 'discarded'
	draftChangeClock++
	const evt = traceHook !== null ? traceHook('draft-discard', null, draft.openEvent) : NO_EVENT
	for (const cell of draft.cells) {
		draftRevisionByCell.set(cell, draftChangeClock)
		pokeDraftWatchers(cell, evt)
	}
	releaseLogs(draft)
	maybeQuiesce()
}

/** Drop finished logs; otherwise fold their globally-dead leading run into
 * valueBeforeDrafts. Folding stops at the first live intent because later
 * updater results may depend on that intent's world-specific value. */
function releaseLogs(dead: Draft): void {
	for (const cell of dead.cells) {
		const log = rebaseLogs.get(cell)
		if (log === undefined) {
			continue
		}
		const intents = log.intents
		let value = log.valueBeforeDrafts
		let prefix = 0
		for (; prefix < intents.length; prefix++) {
			const intent = intents[prefix] as Intent
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
}

/** @internal Test seam for the bounded-history invariant. */
export function rebaseLogIntentCount<T>(cell: CellNode<T>): number {
	return rebaseLogs.get(cell as CellNode<unknown>)?.intents.length ?? 0
}

/** Quiescence: with no live drafts, every per-suspension structure empties. */
function maybeQuiesce(): void {
	if (liveDrafts.size > 0) {
		return
	}
	rebaseLogs.clear()
	for (const node of memoNodes) {
		node.worldMemos = null
	}
	memoNodes.clear()
}

/** True while the draft is open or sealed (retired/discarded ids are dead:
 * their effects are already folded into base state or rolled back). */
export function isLiveDraft(id: DraftId): boolean {
	return liveDrafts.has(id)
}

const NO_IDS: readonly DraftId[] = []

/** Live drafts holding intents against this node's base-state sources (the
 * node itself for a cell; its transitive dependency cells for a derived).
 * Serves late-subscription repair: a subscriber that mounted after the
 * write-time wakes asks which transitions it missed. */
export function draftsAffecting(node: ReactiveNode): readonly DraftId[] {
	if (liveDrafts.size === 0) {
		return NO_IDS
	}
	const sources = new Set<CellNode<unknown>>()
	const visited = new Set<ReactiveNode>()
	const collect = (n: ReactiveNode): void => {
		if (visited.has(n)) {
			return
		}
		visited.add(n)
		if ((n.flags & Flag.KindCell) !== 0) {
			sources.add(n as CellNode<unknown>)
			return
		}
		for (let l = n.deps; l !== undefined; l = l.nextDep) {
			collect(l.dep)
		}
	}
	collect(node)
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
// Write classification
// ---------------------------------------------------------------------------

/** Explicit draft scope (startTransitionWrite / adapter runInBatch). */
let currentDraft: Draft | null = null
/** Ambient classifier installed by the React bindings: detects writes issued
 * inside React.startTransition without our helper. */
let ambientClassifier: (() => Draft | null) | null = null

export function setAmbientClassifier(fn: (() => Draft | null) | null): void {
	ambientClassifier = fn
}

export function runInDraft<T>(draft: Draft, fn: () => T): T {
	const prev = currentDraft
	currentDraft = draft
	try {
		return fn()
	} finally {
		currentDraft = prev
	}
}

export function classifyWrite(): Draft | null {
	if (currentDraft !== null) {
		return currentDraft
	}
	if (ambientClassifier !== null) {
		return ambientClassifier()
	}
	return null
}

// ---------------------------------------------------------------------------
// World resolution
// ---------------------------------------------------------------------------

/** The draft selection visible to one read, render pass, or committed root.
 * It is a replay filter, not a graph copy or a React lane. */
export interface World {
	/** Live drafts, in creation order. */
	drafts: readonly Draft[]
	sig: string
}

export const BASE_WORLD: World = { drafts: [], sig: '' }

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

/** World objects per id-array identity (React state arrays are stable
 * across renders, so this makes repeated resolves allocation-free). */
const worldCache = new WeakMap<
	readonly DraftId[],
	{ validAtDraftChange: DraftChangeClock; world: World }
>()

export function worldOf(ids: readonly DraftId[]): World {
	if (ids.length === 0) {
		return BASE_WORLD
	}
	const hit = worldCache.get(ids)
	if (hit !== undefined && hit.validAtDraftChange === draftChangeClock) {
		return hit.world
	}
	// Normalize React's id set: dead drafts drop out, and Map iteration restores
	// creation order regardless of dispatch arrival order.
	const drafts: Draft[] = []
	let sig = ''
	for (const [id, draft] of liveDrafts) {
		if (ids.includes(id)) {
			drafts.push(draft)
			sig = sig === '' ? String(id) : `${sig},${id}`
		}
	}
	const world = drafts.length === 0 ? BASE_WORLD : { drafts, sig }
	worldCache.set(ids, { validAtDraftChange: draftChangeClock, world })
	return world
}

interface CertificateEntry {
	node: ReactiveNode | null
	changedAtGraphChange: GraphChangeClock
	draftRevision: DraftChangeClock
}

interface Certificate {
	entries: CertificateEntry[]
	count: number
}

interface WorldMemo {
	validAtGraphChange: GraphChangeClock
	validAtDraftChange: DraftChangeClock
	nodeChangedAtGraphChange: GraphChangeClock
	certificate: Certificate
	state: DerivedState
}

/** The certificate currently being collected by a draft-world computed.
 * Arrays and entry objects are reused when a memo re-evaluates. */
let activeCertificate: Certificate | null = null

function appendCertificate(
	node: ReactiveNode,
	changedAtGraphChange: GraphChangeClock,
	draftRevision: DraftChangeClock,
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
		const entry = certificate.entries[i] as CertificateEntry
		appendCertificate(entry.node as ReactiveNode, entry.changedAtGraphChange, entry.draftRevision)
	}
}

function clearInactiveCertificateEntries(certificate: Certificate, previousCount: number): void {
	for (let i = certificate.count; i < previousCount; i++) {
		const entry = certificate.entries[i] as CertificateEntry
		entry.node = null
	}
}

function memoFor(node: ReactiveNode, sig: string): WorldMemo | undefined {
	return node.worldMemos?.get(sig) as WorldMemo | undefined
}

/** Passive view of a world memo's state (no evaluation, no validation). */
export function peekWorldMemo(node: ReactiveNode, sig: string): DerivedState | undefined {
	return memoFor(node, sig)?.state
}

function memoValid(node: ReactiveNode, memo: WorldMemo): boolean {
	const graphChange = currentGraphChange()
	if (memo.validAtGraphChange === graphChange && memo.validAtDraftChange === draftChangeClock) {
		return true
	}
	if (memo.nodeChangedAtGraphChange !== node.changedAtGraphChange) {
		return false
	}
	if (
		(memo.state.flags & Flag.AsyncSuspended) !== 0 &&
		(memo.state.throwable as Suspension).settled
	) {
		return false
	}
	for (let i = 0; i < memo.certificate.count; i++) {
		const entry = memo.certificate.entries[i] as CertificateEntry
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
	memo.validAtDraftChange = draftChangeClock
	return true
}

/** Whether two resolutions are indistinguishable under the node's policy. */
function statesEqual(node: ReactiveNode, left: DerivedState, right: DerivedState): boolean {
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

/** Single-live-draft cutoff. The previous world memo is the last value this
 * write path resolved for the draft; before the first touch, the draft world
 * is identical to base. The graph calls this once per reached node. */
function changedInCutoffWorld(node: ReactiveNode): boolean {
	if ((node.flags & Flag.KindDerived) !== 0 && (node.flags & Flag.WorldAware) === 0) {
		return true
	}
	const world = cutoffWorld!
	try {
		const previous = memoFor(node, world.sig)?.state ?? resolveState(node, BASE_WORLD)
		const next = resolveState(node, world)
		return !statesEqual(node, previous, next)
	} catch {
		// Cutoff evaluation is advisory. An updater that is invalid only when
		// replayed still appends successfully and throws at the ordinary read;
		// do not move that error into the write path.
		return true
	}
}

/** Resolve a node's value as seen by a world. The base world hits the
 * ordinary graph and returns the NODE ITSELF as the state view (cells and
 * deriveds carry the DerivedState shape; the trivial read allocates
 * nothing); drafted worlds replay intents (cells) or draft-evaluate
 * (deriveds) into memo records per (node, world signature). */
export function resolveState(node: ReactiveNode, world: World): DerivedState {
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
	let fresh: DerivedState
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
		fresh = { flags: 0, value: replayLog(cell, world), throwable: null }
	} else {
		fresh = draftEvaluate(node as DerivedNode<unknown>, world, memo?.state, certificate)
	}
	// Keep the previous state record when the fresh resolution is
	// indistinguishable, so identity-comparing subscribers do not re-render.
	const previousState = memo?.state
	const state =
		previousState !== undefined && statesEqual(node, previousState, fresh)
			? previousState
			: fresh
	if (memo === undefined) {
		memo = {
			validAtGraphChange: currentGraphChange(),
			validAtDraftChange: draftChangeClock,
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
		memo.validAtDraftChange = draftChangeClock
		memo.nodeChangedAtGraphChange = node.changedAtGraphChange
		memo.state = state
	}
	recordSource(node)
	inheritCertificate(certificate)
	return state
}

function draftEvaluate(
	node: DerivedNode<unknown>,
	world: World,
	prev: DerivedState | undefined,
	certificate: Certificate,
): DerivedState {
	// Suspense retries must observe one stable thenable per pending span.
	const suspension =
		prev !== undefined &&
		(prev.flags & Flag.AsyncSuspended) !== 0 &&
		!(prev.throwable as Suspension).settled
			? (prev.throwable as Suspension)
			: makeSuspension()
	const worldUse = (t: PromiseLike<unknown>): unknown => {
		const box = trackThenable(t)
		if (box.status === 'fulfilled') {
			return box.value
		}
		if (box.status === 'rejected') {
			throw box.reason
		}
		box.parkedSuspensions.add(suspension)
		throw WORLD_PARKED
	}
	const prevPark = currentPark
	const prevCertificate = activeCertificate
	const previousCertificateCount = certificate.count
	currentPark = worldUse
	activeCertificate = certificate
	certificate.count = 0
	node.flags |= Flag.DraftComputing
	const prevEvaluation = setActiveEvaluation(node)
	try {
		const previous = isUninitialized(node.value) ? undefined : node.value
		const value = untracked(() => withWorld(world, () => node.fn(worldUse as never, previous)))
		return { flags: 0, value, throwable: null }
	} catch (e) {
		if (e === WORLD_PARKED) {
			// The base value doubles as the stale serve (sentinel = none yet).
			return { flags: Flag.AsyncSuspended, value: node.value, throwable: suspension }
		}
		if (
			prev !== undefined &&
			(prev.flags & Flag.AsyncError) !== 0 &&
			(prev.throwable as ErrorBox).error === e
		) {
			return prev
		}
		return { flags: Flag.AsyncError, value: node.value, throwable: makeErrorBox(e) }
	} finally {
		clearInactiveCertificateEntries(certificate, previousCertificateCount)
		activeCertificate = prevCertificate
		currentPark = prevPark
		setActiveEvaluation(prevEvaluation)
		node.flags &= ~Flag.DraftComputing
	}
}

const WORLD_PARKED = Symbol('world-parked')

/** The park function of the draft evaluation in progress (if any); reads of
 * pending values inside that evaluation forward through it. */
let currentPark: ((t: PromiseLike<unknown>) => unknown) | null = null

export function getCurrentPark(): ((t: PromiseLike<unknown>) => unknown) | null {
	return currentPark
}

/** Unwrap a resolved state from inside another evaluation: values flow,
 * errors rethrow their stable reason, suspended forwards by parking the
 * reader (no stale serve here — a world evaluation must not fold a stale
 * base value into a draft-world result). */
export function unwrapForEval(
	st: DerivedState,
	park: (t: PromiseLike<unknown>) => unknown,
): unknown {
	const asyncBits = st.flags & Flag.AsyncMask
	if (asyncBits === 0) {
		return st.value
	}
	if (asyncBits === Flag.AsyncError) {
		throw (st.throwable as ErrorBox).error
	}
	return park((st.throwable as Suspension).promise)
}

// ---------------------------------------------------------------------------
// Ambient views
// ---------------------------------------------------------------------------

/** Newest intent: base state plus every live draft, in creation order. */
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

export function setCommittedWorld(container: object, ids: readonly DraftId[]): void {
	committedWorlds.set(container, ids)
}

export function committedWorldOf(container: object | undefined): World {
	if (container === undefined) {
		return BASE_WORLD
	}
	const ids = committedWorlds.get(container)
	return ids === undefined ? BASE_WORLD : worldOf(ids)
}
