/**
 * The reactive dependency graph: doubly-linked dependency/subscriber lists
 * with push-pull invalidation. The algorithm follows alien-signals v3 (MIT),
 * which is the semantics the cross-framework conformance suite pins: lazy
 * cached computeds with equality cutoff, dynamic dependency trimming, exact
 * pull counts, and synchronous effect flushes coalesced by batches.
 *
 * The concurrent layer (engine.ts) plugs in through three seams:
 * - `worldHooks`: while a render pass or world-scoped evaluation is active,
 *   atom and computed reads resolve against that world's overlay instead of
 *   canonical state. Canonical structure (links, flags, caches) is never
 *   touched by world reads, so effects and plain reads keep seeing exactly
 *   the committed-plus-urgent timeline.
 * - `draftNotify` on effect nodes: draft writes (pending React transitions)
 *   must wake React subscribers without dirtying canonical caches;
 *   `collectWatchers` walks subscriber edges read-only to find them.
 * - `onWatched`/`onUnwatched`: an atom's transition between "has at least one
 *   subscriber edge" and "has none" drives observed-lifecycle effects.
 */

export const enum NodeKind {
	Atom = 0,
	Computed = 1,
	Effect = 2,
	Scope = 3,
}

export const enum Flags {
	None = 0,
	Mutable = 1,
	Watching = 2,
	RecursedCheck = 4,
	Recursed = 8,
	Dirty = 16,
	Pending = 32,
	HasChildEffect = 64,
}

export interface Link {
	version: number;
	dep: ReactiveNode;
	sub: ReactiveNode;
	prevDep: Link | undefined;
	nextDep: Link | undefined;
	prevSub: Link | undefined;
	nextSub: Link | undefined;
}

export interface ReactiveNode {
	kind: NodeKind;
	flags: Flags;
	subs: Link | undefined;
	subsTail: Link | undefined;
	deps: Link | undefined;
	depsTail: Link | undefined;
}

export type Equality = (a: unknown, b: unknown) => boolean;

export interface AtomNode extends ReactiveNode {
	kind: NodeKind.Atom;
	/** Canonical value (committed plus applied urgent writes). */
	value: unknown;
	/** Staged value: a write lands here; reads promote it (two-phase so
	 * batched writes settle once, with equality applied at promotion). */
	staged: unknown;
	equals: Equality;
}

export interface ComputedNode extends ReactiveNode {
	kind: NodeKind.Computed;
	value: unknown;
	fn: () => unknown;
	equals: Equality;
}

export interface EffectNode extends ReactiveNode {
	kind: NodeKind.Effect | NodeKind.Scope;
	fn: (() => unknown) | undefined;
	cleanup: unknown;
	/** Set on React-subscription watcher effects: draft writes call this
	 * instead of scheduling a canonical run. */
	draftNotify: ((source: ReactiveNode) => void) | undefined;
}

/** Seams the concurrent engine layer installs (see module doc). */
export const worldHooks: {
	/** Non-null while reads should resolve in a non-canonical world. */
	active: boolean;
	atomValue: (node: AtomNode) => unknown;
	computedValue: (node: ComputedNode) => unknown;
	onWatched: (node: ReactiveNode) => void;
	onUnwatched: (node: ReactiveNode) => void;
} = {
	active: false,
	atomValue: (node) => node.value,
	computedValue: (node) => node.value,
	onWatched: () => {},
	onUnwatched: () => {},
};

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: ReactiveNode | undefined;
const queued: Array<EffectNode | undefined> = [];

export function getActiveSub(): ReactiveNode | undefined {
	return activeSub;
}

export function setActiveSub(sub: ReactiveNode | undefined): ReactiveNode | undefined {
	const prev = activeSub;
	activeSub = sub;
	return prev;
}

export function untracked<T>(fn: () => T): T {
	const prev = setActiveSub(undefined);
	try {
		return fn();
	} finally {
		activeSub = prev;
	}
}

export function startBatch(): void {
	++batchDepth;
}

export function endBatch(): void {
	if (!--batchDepth) {
		flush();
	}
}

export function batch<T>(fn: () => T): T {
	startBatch();
	try {
		return fn();
	} finally {
		endBatch();
	}
}

function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
	const prevDep = sub.depsTail;
	if (prevDep !== undefined && prevDep.dep === dep) {
		return;
	}
	const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps;
	if (nextDep !== undefined && nextDep.dep === dep) {
		nextDep.version = version;
		sub.depsTail = nextDep;
		return;
	}
	const prevSub = dep.subsTail;
	if (prevSub !== undefined && prevSub.version === version && prevSub.sub === sub) {
		return;
	}
	const hadSubs = dep.subs !== undefined;
	const newLink: Link = {
		version,
		dep,
		sub,
		prevDep,
		nextDep,
		prevSub,
		nextSub: undefined,
	};
	sub.depsTail = newLink;
	dep.subsTail = newLink;
	if (nextDep !== undefined) {
		nextDep.prevDep = newLink;
	}
	if (prevDep !== undefined) {
		prevDep.nextDep = newLink;
	} else {
		sub.deps = newLink;
	}
	if (prevSub !== undefined) {
		prevSub.nextSub = newLink;
	} else {
		dep.subs = newLink;
	}
	if (!hadSubs) {
		worldHooks.onWatched(dep);
	}
}

function unlink(l: Link, sub: ReactiveNode = l.sub): Link | undefined {
	const { dep, prevDep, nextDep, nextSub, prevSub } = l;
	if (nextDep !== undefined) {
		nextDep.prevDep = prevDep;
	} else {
		sub.depsTail = prevDep;
	}
	if (prevDep !== undefined) {
		prevDep.nextDep = nextDep;
	} else {
		sub.deps = nextDep;
	}
	if (nextSub !== undefined) {
		nextSub.prevSub = prevSub;
	} else {
		dep.subsTail = prevSub;
	}
	if (prevSub !== undefined) {
		prevSub.nextSub = nextSub;
	} else if ((dep.subs = nextSub) === undefined) {
		unwatched(dep);
		worldHooks.onUnwatched(dep);
	}
	return nextDep;
}

function unwatched(node: ReactiveNode): void {
	if (node.kind === NodeKind.Computed) {
		// A computed with no subscribers left re-becomes a cold candidate: drop
		// its own dependency edges and mark it dirty so a future read
		// re-evaluates from scratch.
		if (node.depsTail !== undefined) {
			node.flags = Flags.Mutable | Flags.Dirty;
			disposeAllDepsInReverse(node);
		}
	} else if (node.kind === NodeKind.Effect || node.kind === NodeKind.Scope) {
		disposeEffect(node as EffectNode);
	}
}

function propagate(current: Link, innerWrite: boolean): void {
	let next = current.nextSub;
	let stack: { value: Link | undefined; prev: typeof stack } | undefined;
	top: do {
		const sub = current.sub;
		let flags = sub.flags;
		if (!(flags & (Flags.RecursedCheck | Flags.Recursed | Flags.Dirty | Flags.Pending))) {
			sub.flags = flags | Flags.Pending;
			if (innerWrite) {
				sub.flags |= Flags.Recursed;
			}
		} else if (!(flags & (Flags.RecursedCheck | Flags.Recursed))) {
			flags = Flags.None;
		} else if (!(flags & Flags.RecursedCheck)) {
			sub.flags = (flags & ~Flags.Recursed) | Flags.Pending;
		} else if (!(flags & (Flags.Dirty | Flags.Pending)) && isValidLink(current, sub)) {
			sub.flags = flags | (Flags.Recursed | Flags.Pending);
			flags &= Flags.Mutable;
		} else {
			flags = Flags.None;
		}
		if (flags & Flags.Watching) {
			notify(sub as EffectNode);
		}
		if (flags & Flags.Mutable) {
			const subSubs = sub.subs;
			if (subSubs !== undefined) {
				const nextSub = (current = subSubs).nextSub;
				if (nextSub !== undefined) {
					stack = { value: next, prev: stack };
					next = nextSub;
				}
				continue;
			}
		}
		if ((current = next!) !== undefined) {
			next = current.nextSub;
			continue;
		}
		while (stack !== undefined) {
			current = stack.value!;
			stack = stack.prev;
			if (current !== undefined) {
				next = current.nextSub;
				continue top;
			}
		}
		break;
	} while (true);
}

function checkDirty(current: Link, sub: ReactiveNode): boolean {
	let stack: { value: Link; prev: typeof stack } | undefined;
	let checkDepth = 0;
	let dirty = false;
	top: do {
		const dep = current.dep;
		const flags = dep.flags;
		if (sub.flags & Flags.Dirty) {
			dirty = true;
		} else if ((flags & (Flags.Mutable | Flags.Dirty)) === (Flags.Mutable | Flags.Dirty)) {
			const subs = dep.subs!;
			if (update(dep)) {
				if (subs.nextSub !== undefined) {
					shallowPropagate(subs);
				}
				dirty = true;
			}
		} else if ((flags & (Flags.Mutable | Flags.Pending)) === (Flags.Mutable | Flags.Pending)) {
			stack = { value: current, prev: stack };
			current = dep.deps!;
			sub = dep;
			++checkDepth;
			continue;
		}
		if (!dirty) {
			const nextDep = current.nextDep;
			if (nextDep !== undefined) {
				current = nextDep;
				continue;
			}
		}
		while (checkDepth--) {
			current = stack!.value;
			stack = stack!.prev;
			if (dirty) {
				const subs = sub.subs!;
				if (update(sub)) {
					if (subs.nextSub !== undefined) {
						shallowPropagate(subs);
					}
					sub = current.sub;
					continue;
				}
				dirty = false;
			} else {
				sub.flags &= ~Flags.Pending;
			}
			sub = current.sub;
			const nextDep = current.nextDep;
			if (nextDep !== undefined) {
				current = nextDep;
				continue top;
			}
		}
		return dirty && !!sub.flags;
	} while (true);
}

function shallowPropagate(current: Link): void {
	do {
		const sub = current.sub;
		const flags = sub.flags;
		if ((flags & (Flags.Pending | Flags.Dirty)) === Flags.Pending) {
			sub.flags = flags | Flags.Dirty;
			if ((flags & (Flags.Watching | Flags.RecursedCheck)) === Flags.Watching) {
				notify(sub as EffectNode);
			}
		}
	} while ((current = current.nextSub!) !== undefined);
}

function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
	let l = sub.depsTail;
	while (l !== undefined) {
		if (l === checkLink) {
			return true;
		}
		l = l.prevDep;
	}
	return false;
}

function update(node: ReactiveNode): boolean {
	if (node.kind === NodeKind.Computed) {
		return updateComputed(node as ComputedNode);
	}
	if (node.kind === NodeKind.Atom) {
		return updateAtom(node as AtomNode);
	}
	node.flags = Flags.Mutable;
	return true;
}

function notify(e: EffectNode): void {
	// Depth-first ordering: an effect queued while its parent effect is
	// already queued runs after the parent (the parent may unmount it).
	let insertIndex = queuedLength;
	const firstInsertedIndex = insertIndex;
	let node: EffectNode | undefined = e;
	do {
		queued[insertIndex++] = node;
		node.flags &= ~Flags.Watching;
		node = node.subs?.sub as EffectNode | undefined;
		if (node === undefined || !(node.flags & Flags.Watching)) {
			break;
		}
	} while (true);
	queuedLength = insertIndex;
	let lo = firstInsertedIndex;
	let hi = insertIndex;
	while (lo < --hi) {
		const left = queued[lo];
		queued[lo++] = queued[hi];
		queued[hi] = left;
	}
}

function updateAtom(s: AtomNode): boolean {
	s.flags = Flags.Mutable;
	const changed = !s.equals(s.value, s.staged);
	s.value = s.staged;
	return changed;
}

function updateComputed(c: ComputedNode): boolean {
	if (c.flags & Flags.HasChildEffect) {
		let l = c.depsTail;
		while (l !== undefined) {
			const prev = l.prevDep;
			const dep = l.dep;
			if (dep.kind === NodeKind.Effect || dep.kind === NodeKind.Scope) {
				unlink(l, c);
			}
			l = prev;
		}
	}
	c.depsTail = undefined;
	c.flags = Flags.Mutable | Flags.RecursedCheck;
	const prevSub = setActiveSub(c);
	try {
		++cycle;
		const oldValue = c.value;
		const newValue = c.fn();
		const changed = !c.equals(oldValue, newValue);
		if (changed) {
			c.value = newValue;
		}
		return changed;
	} finally {
		activeSub = prevSub;
		c.flags &= ~Flags.RecursedCheck;
		purgeDeps(c);
	}
}

function run(e: EffectNode): void {
	const flags = e.flags;
	if (flags & Flags.Dirty || (flags & Flags.Pending && checkDirty(e.deps!, e))) {
		if (e.draftNotify !== undefined) {
			// Watcher effects deliver; they do not re-track (their single
			// dependency edge is placed once, at subscription).
			e.flags = Flags.Watching | (flags & Flags.HasChildEffect);
			runWatcher(e);
			return;
		}
		if (flags & Flags.HasChildEffect) {
			let l = e.depsTail;
			while (l !== undefined) {
				const prev = l.prevDep;
				const dep = l.dep;
				if (dep.kind === NodeKind.Effect || dep.kind === NodeKind.Scope) {
					unlink(l, e);
				}
				l = prev;
			}
		}
		if (e.cleanup !== undefined) {
			runCleanup(e);
			if (!e.flags) {
				return;
			}
		}
		e.depsTail = undefined;
		e.flags = Flags.Watching | Flags.RecursedCheck;
		const prevSub = setActiveSub(e);
		try {
			++cycle;
			++runDepth;
			e.cleanup = e.fn!();
		} finally {
			--runDepth;
			activeSub = prevSub;
			e.flags &= ~Flags.RecursedCheck;
			purgeDeps(e);
		}
	} else if (e.deps !== undefined) {
		e.flags = Flags.Watching | (flags & Flags.HasChildEffect);
	}
}

function runCleanup(e: EffectNode): void {
	const cleanup = e.cleanup as () => void;
	e.cleanup = undefined;
	const prevSub = activeSub;
	activeSub = undefined;
	try {
		cleanup();
	} finally {
		activeSub = prevSub;
	}
}

function runWatcher(e: EffectNode): void {
	const prevSub = setActiveSub(undefined);
	try {
		e.draftNotify!(e.deps !== undefined ? e.deps.dep : e);
	} finally {
		activeSub = prevSub;
	}
}

function flush(): void {
	try {
		while (notifyIndex < queuedLength) {
			const e = queued[notifyIndex]!;
			queued[notifyIndex++] = undefined;
			run(e);
		}
	} finally {
		// If an effect threw, requeue the rest as notified-dirty so state stays
		// coherent, then reset the queue.
		while (notifyIndex < queuedLength) {
			const e = queued[notifyIndex]!;
			queued[notifyIndex++] = undefined;
			e.flags |= Flags.Watching | Flags.Recursed;
		}
		notifyIndex = 0;
		queuedLength = 0;
	}
}

// ---------------------------------------------------------------------------
// Node factories and canonical read/write operations.
// ---------------------------------------------------------------------------

export function createAtomNode(value: unknown, equals: Equality): AtomNode {
	return {
		kind: NodeKind.Atom,
		flags: Flags.Mutable,
		subs: undefined,
		subsTail: undefined,
		deps: undefined,
		depsTail: undefined,
		value,
		staged: value,
		equals,
	};
}

export function createComputedNode(fn: () => unknown, equals: Equality): ComputedNode {
	return {
		kind: NodeKind.Computed,
		flags: Flags.None,
		subs: undefined,
		subsTail: undefined,
		deps: undefined,
		depsTail: undefined,
		value: undefined,
		fn,
		equals,
	};
}

/** Canonical atom read: promotes a staged write, links to the active
 * subscriber. World-scoped reads divert to the engine's world resolver but
 * still link (the canonical edge is what makes draft delivery reachable). */
export function readAtom(s: AtomNode): unknown {
	if (worldHooks.active) {
		return worldHooks.atomValue(s);
	}
	if (s.flags & Flags.Dirty) {
		if (updateAtom(s)) {
			const subs = s.subs;
			if (subs !== undefined) {
				shallowPropagate(subs);
			}
		}
	}
	const sub = activeSub;
	if (sub !== undefined) {
		link(s, sub, cycle);
	}
	return s.value;
}

/** The settled canonical value of an atom (staged write promoted), with no
 * dependency linking: the base a world fold starts from. */
export function canonicalAtomValue(s: AtomNode): unknown {
	if (s.flags & Flags.Dirty) {
		if (updateAtom(s)) {
			const subs = s.subs;
			if (subs !== undefined) {
				shallowPropagate(subs);
			}
		}
	}
	return s.value;
}

/** Marks a computed dirty and propagates, as a write would: the engine's
 * async settlements invalidate through here. Flushes when unbatched. */
export function invalidateComputed(c: ComputedNode): void {
	c.flags |= Flags.Dirty;
	const subs = c.subs;
	if (subs !== undefined) {
		propagate(subs, runDepth > 0);
		if (!batchDepth) {
			flush();
		}
	}
}

/** Canonical atom write: stages the value, dirties, propagates, and flushes
 * effects when no batch is open. */
export function writeAtom(s: AtomNode, value: unknown): void {
	if (!s.equals(s.staged, value)) {
		s.staged = value;
		s.flags = Flags.Mutable | Flags.Dirty;
		const subs = s.subs;
		if (subs !== undefined) {
			propagate(subs, runDepth > 0);
			if (!batchDepth) {
				flush();
			}
		}
	}
}

export function readComputed(c: ComputedNode): unknown {
	if (worldHooks.active) {
		return worldHooks.computedValue(c);
	}
	const flags = c.flags;
	if (
		flags & Flags.Dirty ||
		(flags & Flags.Pending && (checkDirty(c.deps!, c) || ((c.flags = flags & ~Flags.Pending), false)))
	) {
		if (updateComputed(c)) {
			const subs = c.subs;
			if (subs !== undefined) {
				shallowPropagate(subs);
			}
		}
	} else if (!flags) {
		c.flags = Flags.Mutable | Flags.RecursedCheck;
		const prevSub = setActiveSub(c);
		try {
			c.value = c.fn();
		} finally {
			activeSub = prevSub;
			c.flags &= ~Flags.RecursedCheck;
		}
	}
	const sub = activeSub;
	if (sub !== undefined) {
		link(c, sub, cycle);
	}
	return c.value;
}

export interface EffectOptions {
	/** Watcher mode: draft/canonical changes call this instead of re-running
	 * `fn`. The node keeps its dependency edges from the initial run. */
	draftNotify?: (source: ReactiveNode) => void;
}

/** Creates and immediately runs an effect; returns its node (dispose with
 * `disposeEffect`). Nests under the active effect/scope for ownership. */
export function createEffect(fn: () => unknown, options?: EffectOptions): EffectNode {
	const e: EffectNode = {
		kind: NodeKind.Effect,
		flags: Flags.Watching | Flags.RecursedCheck,
		subs: undefined,
		subsTail: undefined,
		deps: undefined,
		depsTail: undefined,
		fn,
		cleanup: undefined,
		draftNotify: options?.draftNotify,
	};
	const prevSub = setActiveSub(e);
	if (prevSub !== undefined) {
		link(e, prevSub, 0);
		prevSub.flags |= Flags.HasChildEffect;
	}
	try {
		++runDepth;
		e.cleanup = e.fn!();
	} finally {
		--runDepth;
		activeSub = prevSub;
		e.flags &= ~Flags.RecursedCheck;
	}
	return e;
}

export function createScope(fn: () => void): EffectNode {
	const e: EffectNode = {
		kind: NodeKind.Scope,
		flags: Flags.Mutable,
		subs: undefined,
		subsTail: undefined,
		deps: undefined,
		depsTail: undefined,
		fn: undefined,
		cleanup: undefined,
		draftNotify: undefined,
	};
	const prevSub = setActiveSub(e);
	if (prevSub !== undefined) {
		link(e, prevSub, 0);
		prevSub.flags |= Flags.HasChildEffect;
	}
	try {
		fn();
	} finally {
		activeSub = prevSub;
	}
	return e;
}

export function disposeEffect(e: EffectNode): void {
	e.flags = Flags.None;
	disposeAllDepsInReverse(e);
	const sub = e.subs;
	if (sub !== undefined) {
		unlink(sub);
	}
	if (e.kind === NodeKind.Effect && e.cleanup !== undefined) {
		runCleanup(e);
	}
}

function disposeAllDepsInReverse(sub: ReactiveNode): void {
	let l = sub.depsTail;
	while (l !== undefined) {
		const prev = l.prevDep;
		unlink(l, sub);
		l = prev;
	}
}

function purgeDeps(sub: ReactiveNode): void {
	const depsTail = sub.depsTail;
	let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;
	while (dep !== undefined) {
		dep = unlink(dep, sub);
	}
}

/**
 * Read-only reachability walk for draft writes: collects every watcher
 * effect (draftNotify set) transitively downstream of `node` without
 * touching any flags or caches — a draft write must wake React subscribers
 * while leaving canonical state exactly as it was.
 */
export function collectWatchers(node: ReactiveNode, out: Set<EffectNode>, seen?: Set<ReactiveNode>): void {
	const visited = seen ?? new Set<ReactiveNode>();
	if (visited.has(node)) {
		return;
	}
	visited.add(node);
	let l = node.subs;
	while (l !== undefined) {
		const sub = l.sub;
		if ((sub as EffectNode).draftNotify !== undefined) {
			out.add(sub as EffectNode);
		} else if (sub.kind === NodeKind.Computed) {
			collectWatchers(sub, out, visited);
		}
		l = l.nextSub;
	}
}

/** Test seam: true when no effects are queued and no batch is open. */
export function graphQuiescent(): boolean {
	return queuedLength === 0 && batchDepth === 0;
}
