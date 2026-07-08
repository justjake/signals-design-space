/**
 * The host seam: registration handshake, the provider registry that carries
 * transition drafts into React state, write classification for plain
 * React.startTransition scopes, the write-during-render guard, and the DOM
 * mutation window surface.
 *
 * The design premise of this package: React itself is the world clock.
 * A transition draft becomes visible to a render pass only because that
 * pass's SignalScope reducer state contains the draft id — and React's own
 * update queues decide which passes those are. The bindings never guess at
 * lanes; they read worlds out of React state.
 */
import * as React from 'react';
import {
  reactIntegration as engine,
  resetEngineForTest,
  type DraftId,
} from 'signals-royale-fx2';

/** One registered SignalScope instance (one per root in practice). */
export interface ProviderRecord {
  dispatch: (id: DraftId) => void;
  container: object | null;
}

export interface ReactSignalsHandle {
  /** Errors captured from user callbacks and React roots; tests assert []. */
  errors: unknown[];
  dispose(): void;
}

const providers = new Set<ProviderRecord>();
/** Providers that received each draft's dispatch and have not committed it. */
const draftRecipients = new Map<DraftId, Set<ProviderRecord>>();
const mutationSubs = new Set<(phase: 'start' | 'stop', container: Element) => void>();
/** Hook dispatchers observed during renders; a write under one is a bug. */
const renderDispatchers = new WeakSet<object>();

let handle: ReactSignalsHandle | null = null;

interface SharedInternals {
  H?: object | null;
  T?: object | null;
}

function sharedInternals(): SharedInternals {
  const secret = (React as unknown as Record<string, unknown>)[
    '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'
  ];
  return (secret ?? {}) as SharedInternals;
}

/** Record "we are rendering under this dispatcher" — called by every hook. */
export function captureRenderDispatcher(): void {
  const H = sharedInternals().H;
  if (H != null) renderDispatchers.add(H);
}

function renderWriteGuard(): void {
  const H = sharedInternals().H;
  if (H != null && renderDispatchers.has(H)) {
    throw new Error(
      'signals-royale-fx2: state was written during a React render. ' +
        'Render must be pure; move the write into an event handler or effect.',
    );
  }
}

/** Drafts created for plain React.startTransition scopes (no helper). */
const draftsByTransition = new WeakMap<object, DraftId>();

function ambientClassifier(): DraftId | null {
  const T = sharedInternals().T;
  if (T == null) return null;
  let id = draftsByTransition.get(T);
  if (id === undefined) {
    id = engine.openDraft().id;
    draftsByTransition.set(T, id);
    broadcastDraft(id);
  }
  return id;
}

/** Send a draft id to every provider, inside the current React context, so
 * the dispatches ride the transition's own lanes. */
export function broadcastDraft(id: DraftId): void {
  const recipients = new Set(providers);
  draftRecipients.set(id, recipients);
  for (const p of recipients) p.dispatch(id);
  if (recipients.size === 0) {
    // No mounted scope observes this draft; it retires as soon as the
    // writing scope finishes (microtask keeps ops-append ordering).
    queueMicrotask(() => {
      if (draftRecipients.get(id)?.size === 0) {
        draftRecipients.delete(id);
        engine.retireDraft(id);
      }
    });
  }
}

/** Drafts some render pass has already resolved against. An append to one
 * of these re-dispatches, so React restarts the passes that saw a partial
 * batch (see SignalScope's module comment). */
const renderedDrafts = new Set<DraftId>();

export function markDraftRendered(id: DraftId): void {
  renderedDrafts.add(id);
}

function handleDraftAppend(id: DraftId): void {
  if (!renderedDrafts.has(id)) return;
  const recipients = draftRecipients.get(id);
  if (recipients === undefined) return;
  for (const p of recipients) p.dispatch(id);
}

export function registerProvider(p: ProviderRecord): () => void {
  providers.add(p);
  return () => {
    providers.delete(p);
    for (const [id, recipients] of draftRecipients) {
      recipients.delete(p);
      if (recipients.size === 0) {
        draftRecipients.delete(id);
        engine.retireDraft(id);
      }
    }
  };
}

/** A provider committed a render pass whose world contained these drafts. */
export function confirmCommit(p: ProviderRecord, ids: readonly DraftId[]): void {
  if (p.container !== null) engine.setCommittedWorld(p.container, ids);
  // Per-root committed views changed; wake their passive subscribers (the
  // useValue crowd bails on equal snapshots, so this is cheap).
  engine.pokeDraftCells(ids);
  for (const id of ids) {
    const recipients = draftRecipients.get(id);
    if (recipients !== undefined && recipients.delete(p) && recipients.size === 0) {
      draftRecipients.delete(id);
      renderedDrafts.delete(id);
      // Silent: render-pass worlds already delivered these values to every
      // subscriber under a scope; the fold must not schedule repairs.
      engine.retireDraft(id, { silent: true });
    }
  }
}

export function reportError(e: unknown): void {
  if (handle !== null) handle.errors.push(e);
}

function dispatchMutationWindow(container: unknown, isStart: boolean): void {
  const phase = isStart ? 'start' : 'stop';
  engine.traceNode(`mutation-${phase}`, null, 0, undefined);
  for (const cb of mutationSubs) {
    try {
      cb(phase, container as Element);
    } catch (e) {
      reportError(e);
    }
  }
}

/** Subscribe to the exact bracket around React's DOM mutation phase, per
 * root commit. Requires a React build with the fx2 protocol. */
export function onDomMutation(cb: (phase: 'start' | 'stop', container: Element) => void): () => void {
  requireRegistered();
  mutationSubs.add(cb);
  return () => {
    mutationSubs.delete(cb);
  };
}

function requireRegistered(): void {
  if (handle === null) {
    throw new Error('signals-royale-fx2: call registerReactSignals() before using the bindings');
  }
}

/**
 * Register the bindings against the current React build. Fails loudly on a
 * build without the fx2 protocol (the mutation window would be silently
 * dead otherwise). Idempotent per process.
 */
export function registerReactSignals(): ReactSignalsHandle {
  if (handle !== null) return handle;
  const marker = (globalThis as Record<string, unknown>).__FX2_REACT_PROTOCOL__;
  if (marker !== 1) {
    throw new Error(
      'signals-royale-fx2: this React build does not implement the fx2 external-state ' +
        'protocol (__FX2_REACT_PROTOCOL__ !== 1). Build React from the fx2 patch series; ' +
        'stock React cannot expose the DOM mutation window these bindings guarantee.',
    );
  }
  (globalThis as Record<string, unknown>).__FX2_MUTATION_WINDOW__ = dispatchMutationWindow;
  engine.setAmbientClassifier(ambientClassifier);
  engine.setRenderWriteGuard(renderWriteGuard);
  engine.setOnDraftAppend(handleDraftAppend);
  handle = {
    errors: [],
    dispose() {
      if (handle === null) return;
      (globalThis as Record<string, unknown>).__FX2_MUTATION_WINDOW__ = undefined;
      engine.setAmbientClassifier(null);
      engine.setRenderWriteGuard(null);
      engine.setOnDraftAppend(null);
      mutationSubs.clear();
      handle = null;
    },
  };
  return handle;
}

/** Test seam: engine reset plus host registry scrub. Keeps registration. */
export function resetReactSignalsForTest(): void {
  const wasRegistered = handle !== null;
  resetEngineForTest();
  providers.clear();
  draftRecipients.clear();
  renderedDrafts.clear();
  mutationSubs.clear();
  if (wasRegistered) {
    // resetEngineForTest cleared the engine hooks; re-arm them.
    (globalThis as Record<string, unknown>).__FX2_MUTATION_WINDOW__ = dispatchMutationWindow;
    engine.setAmbientClassifier(ambientClassifier);
    engine.setRenderWriteGuard(renderWriteGuard);
    engine.setOnDraftAppend(handleDraftAppend);
    handle!.errors.length = 0;
  }
}

declare const queueMicrotask: (fn: () => void) => void;
