import * as React from "react";
import { flushSync } from "react-dom";
import {
  Atom,
  Computed,
  atom,
  attachHost,
  batch,
  collectReactRead,
  committed,
  computed,
  effect,
  initializeAtomState,
  isPending,
  latest,
  read,
  refresh,
  resetForTest as resetEngine,
  serializeAtomState,
  set,
  startTrace,
  subscribePending,
  subscribeReact,
  untracked,
  update,
  type AtomOptions,
  type ComputedOptions,
  type ReactObserver,
  type RootToken,
  type SignalHost,
  type SignalHostListener,
} from "signals-royale-sm1";

type RuntimeListener = {
  onRenderStart?(container: RootToken, lanes: number): void;
  onRenderEnd?(container: RootToken, committed: boolean): void;
  onRootPending?(container: RootToken, lanes: number): void;
  onRootCommit?(container: RootToken, finished: number, remaining: number): void;
  onEventEnd?(): void;
  onBeforeMutation?(container: Element): void;
  onAfterMutation?(container: Element): void;
};

type ForkReact = typeof React & {
  unstable_subscribeToSignalRuntime?(listener: RuntimeListener): () => void;
  unstable_getSignalWriteLane?(): number;
  unstable_getSignalRenderRoot?(): RootToken | null;
  unstable_getSignalRenderLanes?(): number;
  unstable_runInSignalLane?<T>(lane: number, fn: () => T): T;
};

export type Registration = { errors: unknown[]; dispose(): void };

const Fork = React as ForkReact;
const mutationListeners = new Set<(phase: "start" | "stop", container: Element) => void>();
const runtimeErrors: unknown[] = [];
const renderContext: { container: RootToken; lanes: number } = { container: {}, lanes: 0 };
let registrationCount = 0;
let detachEngineHost: (() => void) | null = null;

const signalHost: SignalHost = {
  currentWriteLane() {
    return Fork.unstable_getSignalWriteLane?.() ?? 0;
  },
  renderContext() {
    const container = Fork.unstable_getSignalRenderRoot?.();
    if (container == null) return null;
    renderContext.container = container;
    renderContext.lanes = Fork.unstable_getSignalRenderLanes?.() ?? 0;
    return renderContext;
  },
  runInLane<T>(lane: number, fn: () => T): T {
    const run = Fork.unstable_runInSignalLane;
    return run === undefined ? fn() : run(lane, fn);
  },
  subscribe(listener: SignalHostListener) {
    const subscribe = Fork.unstable_subscribeToSignalRuntime;
    if (subscribe === undefined) throw new Error("The React signal protocol is not installed.");
    return subscribe({
      onRenderStart(container, lanes) {
        listener.onRenderStart(container, lanes);
      },
      onRenderEnd(container, didCommit) {
        listener.onRenderEnd(container, didCommit);
      },
      onRootPending(container, lanes) {
        listener.onRootPending(container, lanes);
      },
      onRootCommit(container, finished, remaining) {
        listener.onRootCommit(container, finished, remaining);
      },
      onEventEnd() {
        listener.onEventEnd();
      },
      onBeforeMutation(container) {
        for (const callback of mutationListeners) callback("start", container);
      },
      onAfterMutation(container) {
        for (const callback of mutationListeners) callback("stop", container);
      },
    });
  },
};

export function register(): Registration {
  if (
    Fork.unstable_subscribeToSignalRuntime === undefined ||
    Fork.unstable_getSignalWriteLane === undefined ||
    Fork.unstable_getSignalRenderRoot === undefined ||
    Fork.unstable_getSignalRenderLanes === undefined ||
    Fork.unstable_runInSignalLane === undefined
  ) {
    throw new Error("react-signals-royale-sm1 requires its patched React build.");
  }
  registrationCount++;
  if (detachEngineHost === null) detachEngineHost = attachHost(signalHost);
  let active = true;
  return {
    errors: runtimeErrors,
    dispose() {
      if (!active) return;
      active = false;
      registrationCount--;
      if (registrationCount === 0 && detachEngineHost !== null) {
        detachEngineHost();
        detachEngineHost = null;
      }
    },
  };
}

function requireRegistration(): void {
  if (detachEngineHost === null) {
    throw new Error("Call register() before rendering signal hooks.");
  }
}

export function useValue<T>(target: Atom<T> | Computed<T>): T {
  requireRegistration();
  const [, renderAgain] = React.useReducer((value: number) => value + 1, 0);
  const cause = React.useRef<number | undefined>(undefined);
  const root = Fork.unstable_getSignalRenderRoot?.();
  if (root == null) throw new Error("useValue must run during a React render.");
  const snapshot = collectReactRead(target, cause.current);
  React.useLayoutEffect(() => {
    const observer: ReactObserver = {
      root,
      notify(nextCause) {
        cause.current = nextCause;
        renderAgain();
      },
    };
    return subscribeReact(snapshot, observer);
  });
  return snapshot.value;
}

export function useComputed<T>(fn: () => T, dependencies: React.DependencyList): T {
  const target = React.useMemo(() => computed(fn), dependencies);
  return useValue(target);
}

export function useAtom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T> {
  return React.useMemo(() => atom(initial, options), []);
}

export function useSignalEffect(fn: () => void | (() => void)): void {
  React.useEffect(() => effect(fn), [fn]);
}

export function useCommitted<T>(target: Atom<T> | Computed<T>): T {
  useValue(target);
  const root = Fork.unstable_getSignalRenderRoot?.();
  return committed(target, root ?? undefined);
}

export function useIsPending<T>(target: Atom<T> | Computed<T>): boolean {
  requireRegistration();
  const [, renderAgain] = React.useReducer((value: number) => value + 1, 0);
  const root = Fork.unstable_getSignalRenderRoot?.();
  if (root == null) throw new Error("useIsPending must run during a React render.");
  React.useLayoutEffect(() => {
    const observer: ReactObserver = { root, notify: () => renderAgain() };
    return subscribePending(target, observer);
  }, [target, root]);
  return isPending(target);
}

export function startTransitionWrite(scope: () => void): void {
  requireRegistration();
  React.startTransition(() => batch(scope));
}

export function onDomMutation(
  callback: (phase: "start" | "stop", container: Element) => void,
): () => void {
  mutationListeners.add(callback);
  return () => mutationListeners.delete(callback);
}

export function resetForTest(): void {
  resetEngine();
  runtimeErrors.length = 0;
  mutationListeners.clear();
}

export {
  Atom,
  Computed,
  React,
  atom,
  batch,
  committed,
  computed,
  effect,
  flushSync,
  initializeAtomState,
  isPending,
  latest,
  read,
  refresh,
  serializeAtomState,
  set,
  startTrace,
  untracked,
  update,
  type AtomOptions,
  type ComputedOptions,
};
