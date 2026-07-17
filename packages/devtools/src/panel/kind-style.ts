/**
 * Shared presentation of kinds: display labels, explanatory tooltips, and the
 * theme color variables the panel styles them with. One table per concept, so
 * a node kind or an event kind reads identically everywhere it appears.
 */
import type { NodeKind, NodeStatus } from '../protocol.ts'

export const KIND_LABEL: Record<NodeKind, string> = { atom: 'Atom', computed: 'Computed', watcher: 'Watcher', effect: 'Effect' }

export const KIND_TIP: Record<NodeKind, string> = {
	atom: 'Atom: holds a value you set directly.',
	computed: 'Computed: derives its value from other nodes; recomputes when they change.',
	watcher: 'Watcher: a UI subscription — usually a component that re-renders when its inputs change.',
	effect: 'Effect: code that runs after changes commit (persistence, document.title, …).',
}

/** The theme color variable for a node kind. */
export function kindVar(kind: NodeKind): string {
	return `var(--${kind})`
}

/** The theme color variable for a node status ('ok' reads muted). */
export function statusVar(status: NodeStatus): string {
	return status === 'error' ? 'var(--danger)' : status === 'suspended' ? 'var(--suspended)' : 'var(--muted)'
}

/** Per-kind tooltip text for event chips. Unknown kinds fall back to a
 * generic error/verbatim hint so a future kind still explains itself. */
const EVENT_KIND_TIPS: Record<string, string> = {
	'dom-event': 'The DOM event that started this operation.',
	set: 'atom.set(value): the atom was assigned a new value.',
	update: 'atom.update(fn): the atom was computed from its previous value.',
	compute: 'A computed ran its function for the first time (came into existence).',
	recompute: 'A computed re-ran its function because an input changed.',
	effect: 'An effect ran after changes committed.',
	notify: 'A watcher was told its inputs changed (re-render scheduled).',
	render: 'A component rendered a committed value.',
	settle: 'An awaited async value resolved.',
	retry: 'A suspended computation retried after its await resolved.',
	'compute-suspend': 'A recompute paused awaiting a Promise.',
	'transition-open': 'A transition began; its updates render in the background.',
	'transition-commit': 'A transition committed to the UI.',
	'transition-retire': 'A committed transition folded into base state.',
	'transition-discard': 'A transition was abandoned.',
	propagate: 'Hot step: a change pushed "possibly stale" marks down to its subscribers.',
	check: 'Hot step: a read walked dependencies to confirm whether anything really changed.',
	pull: 'Hot step: a stale computed or effect computation re-evaluated.',
}

/** Tooltip text for an event kind chip. */
export function kindTip(kind: string): string {
	return EVENT_KIND_TIPS[kind] ?? (kind.endsWith('-error') ? 'This step threw an error.' : kind)
}
