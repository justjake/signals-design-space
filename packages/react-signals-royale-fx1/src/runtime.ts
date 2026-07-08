/**
 * The React host runtime: plugs the signals-royale-fx1 engine into React's
 * scheduler through the fork's signal-scheduler bridge.
 *
 * Scheduling is inverted relative to a subscription store: the ENGINE owns
 * batching. Every transition-classified write opens an engine episode; the
 * runtime claims a React transition lane for it once and pins that lane on
 * the transition object (`_signalLane`). From then on every re-render request
 * for that episode — the original deliveries, corrective joins for components
 * that mount mid-transition, and the settlement of async work the episode
 * owns — dispatches under the same pinned lane, so React commits them as one
 * batch, never beside it. React's only jobs are to honor the pin and to
 * report pass starts, per-root commits, and the DOM mutation window.
 */
import * as React from "react";
import {
  beginPass,
  commitPass,
  episodeFor,
  frameForRoot,
  openEpisodesSnapshot,
  resetEngine,
  setHost,
  trace,
  traceCause,
  type Episode,
  type EngineHost,
  type Frame,
  type Sub,
} from "signals-royale-fx1";

/** React lane bitmask (the fork hands these out; the runtime never decodes them). */
export type LaneBits = number;

interface FiberRootLike {
  containerInfo: Element;
}

interface SignalSchedulerBridge {
  claimTransitionLane: (() => LaneBits) | null;
  getWorkInProgress: (() => { root: FiberRootLike; lanes: LaneBits } | null) | null;
  isRendering: (() => boolean) | null;
  onPassStart: ((root: FiberRootLike, lanes: LaneBits) => void) | null;
  onCommit: ((root: FiberRootLike, lanes: LaneBits) => void) | null;
  onMutation: ((root: FiberRootLike, start: boolean) => void) | null;
}

/** A React transition object, as the engine sees it: an identity that may
 * carry the engine's pinned lane. */
export interface TransitionToken {
  _signalLane?: LaneBits;
}

interface ReactSharedInternalsLike {
  T: TransitionToken | null;
}

function sharedInternals(): ReactSharedInternalsLike {
  const key = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";
  const internals = (React as unknown as Record<string, unknown>)[key];
  if (internals === undefined) {
    throw new Error("react-signals-royale-fx1: unsupported React build (missing client internals)");
  }
  return internals as ReactSharedInternalsLike;
}

let bridge: SignalSchedulerBridge | null = null;
let registered: RuntimeHandle | null = null;

export interface RuntimeHandle {
  errors: unknown[];
  dispose(): void;
}

/** Deliveries a subscriber receives (the hook side implements bump). */
export interface HostSub extends Sub {
  bump(): void;
}

type MutationListener = (phase: "start" | "stop", container: Element) => void;
const mutationListeners = new Set<MutationListener>();

/**
 * Wire the engine to the current React build. Idempotent per process. Fails
 * loudly on a React build that does not carry the fx1 scheduler protocol.
 */
export function register(): RuntimeHandle {
  if (registered !== null) return registered;
  const found = (globalThis as Record<string, unknown>).__SIGNALS_ROYALE_FX1__ as
    SignalSchedulerBridge | undefined;
  if (
    found === undefined ||
    typeof found.claimTransitionLane !== "function" ||
    typeof found.getWorkInProgress !== "function"
  ) {
    throw new Error(
      "react-signals-royale-fx1: this React build does not carry the fx1 signal-scheduler " +
        "protocol (globalThis.__SIGNALS_ROYALE_FX1__). Build react/react-dom from the " +
        "packaged patch series (see build.sh) and link against those artifacts.",
    );
  }
  bridge = found;
  const errors: unknown[] = [];

  found.onPassStart = (root, lanes) => {
    try {
      beginPass(root.containerInfo, episodesInLanes(lanes));
    } catch (e) {
      errors.push(e);
    }
  };
  found.onCommit = (root, lanes) => {
    try {
      commitPass(root.containerInfo, episodesInLanes(lanes));
    } catch (e) {
      errors.push(e);
    }
  };
  found.onMutation = (root, start) => {
    if (mutationListeners.size === 0) return;
    const container = root.containerInfo;
    for (const listener of mutationListeners) {
      try {
        listener(start ? "start" : "stop", container);
      } catch (e) {
        errors.push(e);
      }
    }
  };

  const host: EngineHost = {
    currentBatchToken() {
      const t = sharedInternals().T;
      if (t === null) return null;
      pinLane(t);
      return t as object;
    },
    isRendering() {
      return bridge !== null && bridge.isRendering !== null && bridge.isRendering();
    },
    deliver: (sub, episode) => deliver(sub as HostSub, episode),
    currentPassFrame() {
      // Only a render body counts: between time slices (event handlers) and
      // in commit effects there is no executing pass, so context-bound reads
      // fall back to newest intent.
      if (!this.isRendering()) return null;
      return currentRenderFrame().frame;
    },
  };
  setHost(host);

  registered = {
    errors,
    dispose() {
      if (registered === null) return;
      registered = null;
      setHost(null);
      if (bridge !== null) {
        bridge.onPassStart = null;
        bridge.onCommit = null;
        bridge.onMutation = null;
      }
    },
  };
  return registered;
}

/** Engine reset plus host-registry scrub, for per-test isolation. */
export function resetForTest(): void {
  resetEngine();
  mutationListeners.clear();
  if (registered !== null) registered.errors.length = 0;
}

/** Claim a React lane for the episode's transition token, once. */
function pinLane(token: TransitionToken): void {
  if (token._signalLane === undefined && bridge !== null) {
    token._signalLane = bridge.claimTransitionLane!();
  }
}

function episodesInLanes(lanes: LaneBits): Episode[] {
  const open = openEpisodesSnapshot();
  if (open.length === 0) return [];
  const out: Episode[] = [];
  for (const ep of open) {
    const lane = (ep.token as TransitionToken)._signalLane;
    if (lane !== undefined && (lane & lanes) !== 0) out.push(ep);
  }
  return out;
}

/**
 * Dispatch a subscriber bump. Urgent deliveries dispatch plainly (React's
 * event batching applies); episode deliveries dispatch under the episode's
 * own pinned transition so they land in that batch's commit.
 */
export function deliver(sub: HostSub, episode: Episode | null): void {
  if (trace !== null) {
    sub.causeId = trace.emit(
      "deliver",
      episode !== null ? episode.openTrace : traceCause,
      labelOf(sub.node),
      sub.node,
    );
  }
  if (episode === null) {
    sub.bump();
    return;
  }
  const internals = sharedInternals();
  const prev = internals.T;
  internals.T = episode.token as TransitionToken;
  try {
    sub.bump();
  } finally {
    internals.T = prev;
  }
}

function labelOf(node: unknown): string | undefined {
  return (node as { label?: string }).label;
}

/** The pass frame for the render in progress, or null outside render. */
export function currentRenderFrame(): { frame: Frame | null; rootKey: Element | null } {
  if (bridge === null || bridge.getWorkInProgress === null) {
    return { frame: null, rootKey: null };
  }
  const wip = bridge.getWorkInProgress();
  if (wip === null) return { frame: null, rootKey: null };
  return { frame: frameForRoot(wip.root.containerInfo), rootKey: wip.root.containerInfo };
}

/**
 * Run `scope` classified as a transition: engine writes inside it join one
 * episode, and React state updates inside it join the same pinned lane, so
 * the whole batch commits together. Nested inside an existing transition it
 * joins that transition instead of opening a new one.
 */
export function startTransitionWrite(scope: () => void): void {
  const internals = sharedInternals();
  const prev = internals.T;
  const token: TransitionToken = prev !== null ? prev : {};
  internals.T = token;
  try {
    scope();
  } finally {
    internals.T = prev;
  }
}

/** Ambient episode for the currently-running transition scope, if any. */
export function currentEpisode(): Episode | null {
  const t = sharedInternals().T;
  if (t === null) return null;
  pinLane(t);
  return episodeFor(t as object);
}

/**
 * Subscribe to React's DOM mutation window: `start` fires immediately before
 * React begins mutating a root's DOM for a commit, `stop` immediately after
 * (layout and passive effects run outside the window). Returns an
 * unsubscriber.
 */
export function onDomMutation(cb: MutationListener): () => void {
  mutationListeners.add(cb);
  return () => {
    mutationListeners.delete(cb);
  };
}
