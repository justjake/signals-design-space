import * as React from "react";
import { flushSync as flushReactSync } from "react-dom";
import {
  Atom,
  Computed,
  atom,
  batch,
  commitRoot,
  committed,
  computed,
  effect,
  initializeAtomState,
  installHost,
  isPending,
  latest,
  read,
  refresh,
  reset,
  retireBatch,
  serializeAtomState,
  subscribe,
  subscribePending,
  trace,
  traceEvent,
  untracked,
  withWorld,
  type BatchToken,
} from "signals-royale-sx1";

type Value<T> = Atom<T> | Computed<T>;
type LaneToken = BatchToken & { lane: number; roots: Set<object>; retireTicket: number };

const tokens = new Map<number, LaneToken>();
const mutationListeners = new Set<(phase: "start" | "stop", container: Element) => void>();
let unregister: (() => void) | undefined;
let registered = false;

function tokenFor(lane: number): LaneToken | undefined {
  if (lane === 0) return undefined;
  let token = tokens.get(lane);
  if (token === undefined) {
    token = {
      id: lane,
      lane,
      deferred: React.unstable_isTransitionLane(lane),
      live: true,
      committed: false,
      roots: new Set(),
      retireTicket: 0,
    };
    token.cause = traceEvent("batch-open", undefined, undefined, token);
    tokens.set(lane, token);
  }
  return token;
}

function batchesIn(lanes: number): Set<BatchToken> {
  const found = new Set<BatchToken>();
  for (const token of tokens.values())
    if (React.unstable_lanesInclude(lanes, token.lane)) found.add(token);
  return found;
}

function currentBatch(): LaneToken | undefined {
  return tokenFor(React.unstable_getCurrentUpdateLane());
}

function readForRender<T>(value: Value<T>): { value: T; root?: object; batches: Set<BatchToken> } {
  const context = React.unstable_getRenderContext();
  if (context === null) return { value: read(value), batches: new Set() };
  const batches = batchesIn(context.renderLanes);
  return {
    value: withWorld(batches, context.container, () => read(value)),
    root: context.container,
    batches,
  };
}

export function register(): { errors: unknown[]; dispose(): void } {
  if (registered) return { errors: [], dispose() {} };
  if (typeof React.unstable_subscribeToExternalRuntime !== "function") {
    throw new Error("react-signals-royale-sx1 requires its patched React build");
  }
  registered = true;
  installHost({
    currentBatch,
    isRendering: () => React.unstable_getRenderContext() !== null,
    runInBatch: (token, fn) => React.unstable_runInLane((token as LaneToken).lane, fn),
  });
  unregister = React.unstable_subscribeToExternalRuntime({
    onRenderPassStart(container, lanes) {
      traceEvent("render-pass-start");
      for (const token of batchesIn(lanes)) (token as LaneToken).roots.add(container);
    },
    onRenderPassEnd() {
      traceEvent("render-pass-end");
    },
    onCommit(container, lanes, remaining) {
      const committedTokens = [...batchesIn(lanes)] as LaneToken[];
      traceEvent("root-commit", committedTokens[0]?.cause);
      commitRoot(container, committedTokens);
      for (const token of committedTokens) {
        token.roots.delete(container);
        if (!React.unstable_lanesInclude(remaining, token.lane)) {
          const ticket = ++token.retireTicket;
          Promise.resolve().then(() => {
            if (ticket === token.retireTicket && token.roots.size === 0 && token.live) {
              retireBatch(token, true);
              tokens.delete(token.lane);
            }
          });
        }
      }
    },
    onBeforeMutation(container) {
      traceEvent("dom-mutation-start");
      for (const listener of mutationListeners) listener("start", container);
    },
    onAfterMutation(container) {
      traceEvent("dom-mutation-stop");
      for (const listener of mutationListeners) listener("stop", container);
    },
  });
  return {
    errors: [],
    dispose() {
      unregister?.();
      unregister = undefined;
      registered = false;
      installHost();
    },
  };
}

export function resetForTest(): void {
  reset();
  tokens.clear();
  mutationListeners.clear();
  if (registered) {
    installHost({
      currentBatch,
      isRendering: () => React.unstable_getRenderContext() !== null,
      runInBatch: (token, fn) => React.unstable_runInLane((token as LaneToken).lane, fn),
    });
  }
}

register();

export {
  atom,
  batch,
  committed,
  computed,
  effect,
  initializeAtomState,
  isPending,
  latest,
  read,
  refresh,
  serializeAtomState,
  trace,
  untracked,
};

export function set<T>(value: Atom<T>, next: T): void {
  value.set(next);
}

export function update<T>(value: Atom<T>, fn: (previous: T) => T): void {
  value.update(fn);
}

export function useValue<T>(value: Value<T>): T {
  const [, force] = React.useReducer((count: number) => count + 1, 0);
  const rendered = readForRender(value);
  const valueRef = React.useRef(value);
  valueRef.current = value;
  React.useLayoutEffect(() => {
    let live = true;
    const stop = subscribe(value as Atom<unknown> | Computed<unknown>, (cause) => {
      traceEvent("component-delivery", cause, value);
      if (live) force();
    });
    if (
      rendered.root !== undefined &&
      !Object.is(rendered.value, committed(value, rendered.root))
    ) {
      let owner: LaneToken | undefined;
      for (const token of rendered.batches) if (token.deferred) owner = token as LaneToken;
      if (owner === undefined) force();
      else React.unstable_runInLane(owner.lane, force);
    }
    return () => {
      live = false;
      stop();
    };
  }, [value]);
  return rendered.value;
}

export function useComputed<T>(fn: () => T, deps: readonly unknown[]): T {
  const value = React.useMemo(() => computed(fn), deps);
  return useValue(value);
}

export function useSignalEffect(fn: () => void | (() => void)): void {
  const latestFn = React.useRef(fn);
  latestFn.current = fn;
  React.useEffect(() => effect(() => latestFn.current()), []);
}

export function useCommitted<T>(value: Value<T>): T {
  const context = React.unstable_getRenderContext();
  useValue(value);
  return committed(value, context?.container);
}

export function useIsPending<T>(value: Value<T>): boolean {
  const [, force] = React.useReducer((count: number) => count + 1, 0);
  React.useLayoutEffect(
    () => subscribePending(value, () => flushReactSync(() => force())),
    [value],
  );
  return isPending(value);
}

export function useAtom<T>(initial: T | (() => T)): Atom<T> {
  const value = React.useMemo(() => atom(initial), []);
  React.useEffect(
    () => () => {
      // Component ownership ends all external observation through hook cleanup.
    },
    [value],
  );
  return value;
}

export function startTransitionWrite(scope: () => void): void {
  React.startTransition(scope);
}

export function onDomMutation(
  listener: (phase: "start" | "stop", container: Element) => void,
): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}
