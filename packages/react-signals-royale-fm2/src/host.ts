/**
 * React host integration for signals-royale-fm2.
 *
 * The React build this package targets exposes a tiny host protocol on its
 * shared-internals object: a single event callback for render slices,
 * commits, and the DOM mutation window, plus two lane helpers. This module
 * owns that registration and maps the protocol onto engine concepts:
 *
 * - Render slice start/stop -> set/clear the engine's ambient world (which
 *   pending write batches this pass may see) and the write-during-render
 *   guard.
 * - Commit -> retire the write batches whose lanes are committing, then
 *   advance that root's committed view.
 * - Mutation window -> forward to userland subscribers with the container.
 */
import * as React from 'react';
// Importing the client renderer evaluates the reconciler, which installs
// the protocol helpers on the shared internals object.
import * as ReactDOMClient from 'react-dom/client';
import {
	createBatch,
	retireBatch,
	runInWriteBatch,
	setAmbientWorld,
	setWriteGuard,
	batch as engineBatch,
	createCommittedView,
	resetForTest as engineReset,
	flushLifetimeEffects,
	emitTrace,
	type CommittedView,
	type World,
	type WorldBatch,
} from 'signals-royale-fm2';

/** React lane bitmask (opaque to us beyond bitwise intersection). */
export type Lanes = number;

interface RoyaleReactInternals {
	royaleHost?: ((kind: string, container: unknown, lanes: Lanes) => void) | null;
	royaleProbeLane?: () => Lanes;
	royaleRunWithLane?: (lane: Lanes, fn: () => unknown) => unknown;
}

function sharedInternals(): RoyaleReactInternals {
	const internals = (React as Record<string, unknown>)[
		'__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'
	] as RoyaleReactInternals | undefined;
	if (internals === undefined || internals === null) {
		throw new Error(
			'react-signals-royale-fm2: could not reach React shared internals; is this React 19+?',
		);
	}
	return internals;
}

/** A transition batch pinned to the React lane that will commit it. */
export interface LaneBatch extends WorldBatch {
	lane: Lanes;
}

const laneBatches = new Map<Lanes, LaneBatch>();
/** Weak keys: an unmounted root's container must not be pinned by us. */
let views = new WeakMap<object, CommittedView & { listeners?: Set<() => void> }>();
const mutationSubs = new Set<(phase: 'start' | 'stop', container: Element) => void>();
const registrationErrors: unknown[] = [];

let registered = false;
let renderDepth = 0;
const worldStack: Array<World | null> = [];

/** Dropped roots must not pin their committed views. */
const viewReclaimer =
	typeof FinalizationRegistry === 'function'
		? new FinalizationRegistry<CommittedView>((view) => view.dispose())
		: null;

function viewFor(container: unknown): CommittedView & { listeners?: Set<() => void> } {
	if (typeof container !== 'object' || container === null) return createCommittedView();
	let view = views.get(container);
	if (view === undefined) {
		view = createCommittedView();
		view.listeners = new Set();
		views.set(container, view);
		viewReclaimer?.register(container, view);
	}
	return view;
}

/**
 * Record what a subscriber's committed render put on its root's screen.
 * Called from hooks' layout effects, which only run for renders that
 * actually commit — a suspended or discarded render never records.
 */
export function recordCommitted(container: unknown, node: object, value: unknown): void {
	if (container === null) return;
	const view = viewFor(container);
	if (view.record(node, value) && view.listeners !== undefined) {
		for (const l of [...view.listeners]) l();
	}
}

/** The container of the render slice currently executing (render time only). */
let currentRenderContainer: unknown = null;

export function getCurrentRenderContainer(): unknown {
	return currentRenderContainer;
}

export function getView(container: unknown): CommittedView | null {
	if (typeof container !== 'object' || container === null) return null;
	return views.get(container) ?? null;
}

/** All open transition batches, oldest first. */
export function openLaneBatches(): LaneBatch[] {
	const out: LaneBatch[] = [];
	for (const b of laneBatches.values()) if (b.status === 'open') out.push(b);
	return out.sort((x, y) => x.id - y.id);
}

function worldFor(lanes: Lanes): World {
	const out: LaneBatch[] = [];
	for (const b of laneBatches.values()) {
		if (b.status === 'open' && (b.lane & lanes) !== 0) out.push(b);
	}
	return out.sort((x, y) => x.id - y.id);
}

function guard(): void {
	throw new Error(
		'react-signals-royale-fm2: write during render. Writes must come from ' +
			'event handlers or effects, never from a component body.',
	);
}

function hostEvent(kind: string, container: unknown, lanes: Lanes): void {
	switch (kind) {
		case 'render-start': {
			viewFor(container);
			worldStack.push(setAmbientWorld(worldFor(lanes) as World));
			renderDepth++;
			currentRenderContainer = container;
			setWriteGuard(guard);
			emitTrace('render-start', 0, { lanes });
			break;
		}
		case 'render-stop': {
			setAmbientWorld(worldStack.pop() ?? null);
			renderDepth--;
			currentRenderContainer = null;
			if (renderDepth <= 0) {
				renderDepth = 0;
				setWriteGuard(null);
			}
			emitTrace('render-stop', 0, { lanes });
			break;
		}
		case 'commit': {
			emitTrace('root-commit', 0, { lanes });
			// Retire every batch whose lanes are committing, then advance this
			// root's committed view so committed() agrees with the new screen.
			for (const [lane, b] of [...laneBatches]) {
				if (b.status === 'open' && (b.lane & lanes) !== 0) {
					retireBatch(b);
					laneBatches.delete(lane);
				}
			}
			break;
		}
		case 'mutation-start':
		case 'mutation-stop': {
			const phase = kind === 'mutation-start' ? 'start' : 'stop';
			for (const cb of [...mutationSubs]) cb(phase, container as Element);
			break;
		}
	}
}

export interface HostHandle {
	errors: unknown[];
	dispose(): void;
}

/**
 * Attach this runtime to the React build. Fails loudly on a React build
 * without the host protocol. Idempotent per process.
 */
export function register(): HostHandle {
	const internals = sharedInternals();
	if (
		typeof internals.royaleProbeLane !== 'function' ||
		typeof internals.royaleRunWithLane !== 'function'
	) {
		throw new Error(
			'react-signals-royale-fm2: this React build does not expose the royale ' +
				'host protocol (render/commit/mutation events + lane helpers). Build ' +
				'the patched fork in this package (see patches/ and build.sh).',
		);
	}
	if (!registered) {
		internals.royaleHost = hostEvent;
		registered = true;
	}
	return {
		errors: registrationErrors,
		dispose() {
			if (sharedInternals().royaleHost === hostEvent) sharedInternals().royaleHost = null;
			registered = false;
		},
	};
}

/**
 * Dispatch updates inside `fn` urgently even when an ambient transition is
 * running (pending probes must flip visibly while the transition parks).
 */
export function runUrgent(fn: () => void): void {
	const internals = sharedInternals() as { T?: unknown };
	const prevT = internals.T;
	internals.T = null;
	try {
		fn();
	} finally {
		internals.T = prevT;
	}
}

/** Pin updates dispatched inside `fn` to `lane` (0 = urgent, no pin). */
export function runWithLane(lane: Lanes, fn: () => void): void {
	if (lane === 0) {
		fn();
		return;
	}
	sharedInternals().royaleRunWithLane!(lane, fn);
}

/**
 * The transition helper: marries React.startTransition with an engine write
 * batch. Writes inside `scope` become drafts owned by the transition's lane;
 * they stay invisible to canonical readers until React commits that lane.
 */
export function startTransitionWrite(scope: () => void): void {
	React.startTransition(() => {
		const internals = sharedInternals();
		const lane = internals.royaleProbeLane!();
		if (lane === 0) {
			// Not a concurrent context: fall back to a plain synchronous batch.
			engineBatch(scope);
			return;
		}
		let b = laneBatches.get(lane);
		if (b === undefined || b.status !== 'open') {
			b = createBatch(true, `transition-${lane}`) as LaneBatch;
			b.lane = lane;
			laneBatches.set(lane, b);
		}
		runInWriteBatch(b, scope);
	});
}

/**
 * Subscribe to the DOM mutation window: `start` fires immediately before
 * React mutates a root's DOM in a commit, `stop` immediately after. User
 * effects and passive effects run outside the window.
 */
export function onDomMutation(
	cb: (phase: 'start' | 'stop', container: Element) => void,
): () => void {
	mutationSubs.add(cb);
	return () => mutationSubs.delete(cb);
}

/** Engine reset plus host registry scrub (tests). */
export function resetForTest(): void {
	engineReset();
	flushLifetimeEffects();
	laneBatches.clear();
	views = new WeakMap(); // engineReset already dropped the views themselves
	mutationSubs.clear();
	registrationErrors.length = 0;
	renderDepth = 0;
	worldStack.length = 0;
	setAmbientWorld(null);
	currentRenderContainer = null;
}

export { React, ReactDOMClient };
