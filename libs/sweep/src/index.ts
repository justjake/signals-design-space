/**
 * @lab/sweep — the no-graph memoized-revalidation baseline (IDEAS.md idea 10).
 *
 * There are NO subscriber lists anywhere. Signals hold one value and bump a
 * global epoch on committed (`!==`) change. Computeds and effects record only
 * FORWARD deps: an interleaved `[dep, valueSeen, dep, valueSeen, ...]` array,
 * rewritten in place each run (cursor + depsEnd — never truncated). A node is
 * stale iff some recorded dep's current value `!==` the value seen when it was
 * read; computeds re-validate lazily on read, memoized per epoch via
 * `validatedAt` (repeated reads within one epoch are O(1)). Recompute happens
 * iff a recorded dep actually changed, checked in recorded order — the same
 * early-cutoff discipline as alien-signals' checkDirty, so recompute counts
 * match upstream on static and dynamic graphs. Glitch freedom is automatic
 * (pure pull).
 *
 * Effects live in a global registry in creation order (parent before child →
 * outer-before-inner). A flush re-validates every live effect and reruns the
 * stale ones, repeating until an entire pass commits no signal change. Writes
 * during effect/computed/cleanup execution are implicitly batched to the end
 * of that execution. When a flush aborts on a thrown error, the remaining
 * live effects are "acquitted" (their seen-values refreshed without running)
 * to match upstream's dropped-notification-queue semantics.
 *
 * Nice property of duplicate dep records (no intra-run dedup): a computed or
 * effect that writes one of its own already-read deps leaves behind a pair
 * recording the pre-write value, so it revalidates as stale — exactly
 * upstream's never-cache-self-invalidating-computed behavior, with zero extra
 * machinery.
 *
 * Costs, by design: every committed write outside a batch is O(live effects ×
 * their deps) to re-validate. This library measures what that costs.
 */

const COMPUTED = 1 as const // node revalidates before its value is compared
const TRACKS = 2 as const // node records deps (computeds + effects)
const EVALUATING = 4 as const // cycle detection mark
const HAS_VALUE = 8 as const // computed has produced a value at least once
const DISPOSED = 16 as const // effect/scope disposed

interface SignalNode<T = unknown> {
	flags: number
	value: T
}

interface OwnerNode {
	flags: number
	/** effects/scopes created during my run; disposed before rerun/dispose. */
	children: (EffectNode | ScopeNode)[] | undefined
}

interface ConsumerNode extends OwnerNode {
	/** interleaved [dep, valueSeen, ...]; the live prefix ends at depsEnd. */
	deps: unknown[]
	depsEnd: number
}

interface ComputedNode<T = unknown> extends ConsumerNode {
	value: T | undefined
	validatedAt: number
	getter: (previousValue?: T) => T
}

interface EffectNode extends ConsumerNode {
	fn: () => (() => void) | void
	cleanup: (() => void) | void
}

interface ScopeNode extends OwnerNode {}

type DepNode = SignalNode | ComputedNode

let epoch = 1
let batchDepth = 0
let needsFlush = false
let flushing = false
let activeSub: ConsumerNode | ScopeNode | undefined

/** Live effects in creation order; tombstoned on dispose, compacted lazily. */
const effects: (EffectNode | undefined)[] = []
let effectsEnd = 0
let liveEffects = 0

/** Callable signal handle: `s()` reads, `s(value)` writes. */
export interface SignalHandle<T> {
	(): T
	(value: T): void
}

export function signal<T>(): SignalHandle<T | undefined>
export function signal<T>(initialValue: T): SignalHandle<T>
export function signal<T>(initialValue?: T): SignalHandle<T | undefined> {
	return signalOper.bind({
		flags: 0,
		value: initialValue,
	}) as SignalHandle<T | undefined>
}

export function computed<T>(getter: (previousValue?: T) => T): () => T {
	return computedOper.bind({
		flags: COMPUTED | TRACKS,
		children: undefined,
		deps: [],
		depsEnd: 0,
		value: undefined,
		validatedAt: 0,
		getter: getter as (previousValue?: unknown) => unknown,
	}) as () => T
}

export function effect(fn: () => (() => void) | void): () => void {
	const e: EffectNode = {
		flags: TRACKS,
		children: undefined,
		deps: [],
		depsEnd: 0,
		fn,
		cleanup: undefined,
	}
	const owner = activeSub
	if (owner !== undefined) {
		;(owner.children ??= []).push(e)
	}
	if (!flushing && effectsEnd - liveEffects > 1024 && liveEffects < effectsEnd >> 1) {
		compactEffects()
	}
	effects[effectsEnd++] = e
	++liveEffects
	activeSub = e
	++batchDepth
	try {
		e.cleanup = e.fn()
	} finally {
		activeSub = owner
		if (!--batchDepth && needsFlush && !flushing) {
			flush()
		}
	}
	return disposeOper.bind(e)
}

export function effectScope(fn: () => void): () => void {
	const s: ScopeNode = {
		flags: 0,
		children: undefined,
	}
	const owner = activeSub
	if (owner !== undefined) {
		;(owner.children ??= []).push(s)
	}
	// No TRACKS flag: reads inside the scope body record nothing, and — unlike
	// an effect body — writes inside it flush immediately (upstream parity).
	activeSub = s
	try {
		fn()
	} finally {
		activeSub = owner
	}
	return disposeOper.bind(s)
}

export function startBatch(): void {
	++batchDepth
}

export function endBatch(): void {
	if (!--batchDepth && needsFlush && !flushing) {
		flush()
	}
}

export function untracked<T>(fn: () => T): T {
	const prevSub = activeSub
	activeSub = undefined
	try {
		return fn()
	} finally {
		activeSub = prevSub
	}
}

function signalOper<T>(this: SignalNode<T>, ...value: [T]): T | void {
	if (value.length) {
		if (this.value !== (this.value = value[0])) {
			++epoch
			if (liveEffects > 0) {
				needsFlush = true
				if (!batchDepth && !flushing) {
					flush()
				}
			}
		}
	} else {
		const sub = activeSub
		if (sub !== undefined && sub.flags & TRACKS) {
			recordDep(sub as ConsumerNode, this, this.value)
		}
		return this.value
	}
}

function computedOper<T>(this: ComputedNode<T>): T {
	if (this.validatedAt !== epoch) {
		validateComputed(this as ComputedNode)
	}
	const sub = activeSub
	if (sub !== undefined && sub.flags & TRACKS) {
		recordDep(sub as ConsumerNode, this, this.value)
	}
	return this.value!
}

function recordDep(sub: ConsumerNode, dep: DepNode, value: unknown): void {
	const i = sub.depsEnd
	const deps = sub.deps
	deps[i] = dep
	deps[i + 1] = value
	sub.depsEnd = i + 2
}

/**
 * Bring `c` up to date: recompute iff some recorded dep's value changed
 * (checked in recorded order, recursively, memoized per epoch).
 */
function validateComputed(c: ComputedNode): void {
	if (c.flags & EVALUATING) {
		throw new Error('Cycle detected')
	}
	if (!(c.flags & HAS_VALUE)) {
		recompute(c)
		return
	}
	const startEpoch = epoch
	const deps = c.deps
	for (let i = 0; i < c.depsEnd; i += 2) {
		const dep = deps[i] as DepNode
		if (dep.flags & COMPUTED && (dep as ComputedNode).validatedAt !== epoch) {
			validateComputed(dep as ComputedNode)
		}
		if (dep.value !== deps[i + 1]) {
			recompute(c)
			return
		}
	}
	// If a dep's recompute wrote a signal mid-walk, startEpoch < epoch keeps
	// the node unvalidated so the next read re-checks the pairs.
	c.validatedAt = startEpoch
}

function recompute(c: ComputedNode): void {
	if (c.children !== undefined) {
		disposeChildren(c)
	}
	c.depsEnd = 0
	c.flags |= EVALUATING
	const prevSub = activeSub
	activeSub = c
	++batchDepth
	const startEpoch = epoch
	try {
		c.value = c.getter(c.value)
		c.flags |= HAS_VALUE
	} finally {
		activeSub = prevSub
		c.flags &= ~EVALUATING
		// A getter that wrote one of its own already-read deps left a stale
		// pair behind AND moved the epoch: startEpoch < epoch leaves the node
		// unvalidated, so the next read re-checks and recomputes (never-cache
		// upstream parity). On throw: pairs recorded so far are kept, value
		// stays old — matches upstream's returns-stale-after-error behavior.
		c.validatedAt = startEpoch
		if (!--batchDepth && needsFlush && !flushing) {
			flush()
		}
	}
}

/** True iff some recorded dep's current value differs from the value seen. */
function isStale(e: EffectNode): boolean {
	const deps = e.deps
	// e.depsEnd is read live: a dispose during a dep's recompute zeroes it.
	for (let i = 0; i < e.depsEnd; i += 2) {
		const dep = deps[i] as DepNode
		if (dep.flags & COMPUTED && (dep as ComputedNode).validatedAt !== epoch) {
			validateComputed(dep as ComputedNode)
		}
		if (dep.value !== deps[i + 1]) {
			return true
		}
	}
	return false
}

/** Refresh seen-values without running — the aborted-flush "drop" path. */
function acquit(e: EffectNode): void {
	const deps = e.deps
	for (let i = 0; i < e.depsEnd; i += 2) {
		const dep = deps[i] as DepNode
		if (dep.flags & COMPUTED && (dep as ComputedNode).validatedAt !== epoch) {
			try {
				validateComputed(dep as ComputedNode)
			} catch {
				// A throwing getter keeps its old value; record that.
			}
		}
		deps[i + 1] = dep.value
	}
}

function flush(): void {
	if (flushing) {
		return
	}
	flushing = true
	try {
		do {
			const startEpoch = epoch
			needsFlush = false
			if (effectsEnd - liveEffects > 32 && liveEffects < effectsEnd >> 1) {
				compactEffects()
			}
			try {
				// effectsEnd is read live: effects created mid-pass run here too.
				for (let i = 0; i < effectsEnd; i++) {
					const e = effects[i]
					if (e === undefined) {
						continue
					}
					if (e.flags & DISPOSED) {
						effects[i] = undefined
						continue
					}
					// Re-check DISPOSED after isStale: validating a dep may run a
					// getter that disposes this very effect.
					if (isStale(e) && !(e.flags & DISPOSED)) {
						runEffect(e)
					}
				}
			} catch (err) {
				// Upstream drops the rest of its notification queue when an
				// effect throws — those effects are not rerun until their deps
				// change AGAIN. Emulate: refresh every live effect's seen-values
				// without running it, then rethrow.
				for (let i = 0; i < effectsEnd; i++) {
					const e = effects[i]
					if (e !== undefined && !(e.flags & DISPOSED)) {
						acquit(e)
					}
				}
				throw err
			}
			if (epoch === startEpoch) {
				break // pass committed no change → every effect is clean
			}
		} while (true)
	} finally {
		needsFlush = false
		flushing = false
	}
}

function runEffect(e: EffectNode): void {
	if (e.children !== undefined) {
		disposeChildren(e)
	}
	if (e.cleanup) {
		try {
			runCleanup(e)
		} catch (err) {
			// Upstream leaves an effect whose cleanup threw permanently
			// dirty-but-unnotified: it never runs again and holds no cleanup.
			// Disposing is observationally the same.
			disposeNode(e)
			throw err
		}
		if (e.flags & DISPOSED) {
			return // cleanup disposed us
		}
	}
	e.depsEnd = 0
	const prevSub = activeSub
	activeSub = e
	++batchDepth
	try {
		e.cleanup = e.fn()
	} finally {
		activeSub = prevSub
		if (!--batchDepth && needsFlush && !flushing) {
			flush()
		}
	}
}

function runCleanup(e: EffectNode): void {
	const cleanup = e.cleanup as () => void
	e.cleanup = undefined
	const prevSub = activeSub
	activeSub = undefined
	++batchDepth
	try {
		cleanup()
	} finally {
		activeSub = prevSub
		if (!--batchDepth && needsFlush && !flushing) {
			flush()
		}
	}
}

function disposeOper(this: EffectNode | ScopeNode): void {
	++batchDepth
	try {
		disposeNode(this)
	} finally {
		if (!--batchDepth && needsFlush && !flushing) {
			flush()
		}
	}
}

function disposeNode(node: EffectNode | ScopeNode): void {
	const firstDispose = !(node.flags & DISPOSED)
	node.flags |= DISPOSED
	if (node.children !== undefined) {
		disposeChildren(node)
	}
	if (node.flags & TRACKS) {
		const e = node as EffectNode
		if (firstDispose) {
			--liveEffects
			e.depsEnd = 0
			e.deps.length = 0 // cold path: release dep/value refs for GC
		}
		// Run a pending cleanup even on re-dispose (an effect that self-disposed
		// mid-run stores its final cleanup afterwards — upstream runs it on the
		// next explicit dispose call).
		if (e.cleanup) {
			runCleanup(e)
		}
	}
}

function disposeChildren(owner: OwnerNode): void {
	const children = owner.children!
	owner.children = undefined
	for (let i = 0; i < children.length; i++) {
		const child = children[i]
		if (!(child.flags & DISPOSED)) {
			disposeNode(child)
		}
	}
}

function compactEffects(): void {
	let j = 0
	for (let i = 0; i < effectsEnd; i++) {
		const e = effects[i]
		if (e !== undefined && !(e.flags & DISPOSED)) {
			effects[j++] = e
		}
	}
	for (let i = j; i < effectsEnd; i++) {
		effects[i] = undefined
	}
	effectsEnd = j
}
