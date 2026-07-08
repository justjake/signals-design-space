import * as React from 'react';
import { Atom, Computed, type AtomOptions } from 'signals-royale-sm2';
import { currentContainer, getRuntime, register } from './protocol';

export type Readable<T> = Atom<T> | Computed<T>;

function useSubscription<T>(node: Readable<T>): void {
  const runtime = getRuntime();
  const [, bump] = React.useReducer((value: number) => value + 1, 0);
  const version = node.version;
  React.useLayoutEffect(() => {
    let mounted = true;
    const deliver = (batchId?: number) => {
      if (!mounted) return;
      runtime.runInBatch(batchId ?? 0, bump);
    };
    const unsubscribe = runtime.subscribe(node, deliver);
    const pending = runtime.pendingBatchIds(node);
    for (const batchId of pending) runtime.runInBatch(batchId, bump);
    if (node.version !== version) runtime.runInBatch(0, bump);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [node, runtime, version]);
}

export function useValue<T>(node: Readable<T>): T {
  register();
  const value = node.get();
  const batches = getRuntime().renderBatches();
  getRuntime().emitDebug({
    kind: 'component-render',
    subject: node,
    batchId: batches === null ? undefined : batches[batches.length - 1],
  });
  useSubscription(node);
  return value;
}

export function useComputed<T>(fn: () => T, dependencies: readonly unknown[]): T {
  const runtime = getRuntime();
  const computed = React.useMemo(() => runtime.computed(fn), dependencies);
  return useValue(computed);
}

export function useSignalEffect(fn: () => void | (() => void)): void {
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  React.useEffect(() => getRuntime().effect(() => fnRef.current()), []);
}

export function useIsPending(node: Readable<unknown>): boolean {
  register();
  const runtime = getRuntime();
  const [, bump] = React.useReducer((value: number) => value + 1, 0);
  React.useLayoutEffect(() => {
    const deliver = () => runtime.runInBatch(0, bump);
    const unsubscribeNode = runtime.subscribe(node, deliver);
    const unsubscribeBatches = runtime.subscribeBatchState(deliver);
    return () => {
      unsubscribeNode();
      unsubscribeBatches();
    };
  }, [node, runtime]);
  return runtime.isPending(node);
}

export function useCommitted<T>(node: Readable<T>): T {
  register();
  const runtime = getRuntime();
  const container = currentContainer();
  const [, bump] = React.useReducer((value: number) => value + 1, 0);
  React.useLayoutEffect(() => {
    const unsubscribeNode = runtime.subscribe(node, (batchId) =>
      runtime.runInBatch(batchId ?? 0, bump),
    );
    const unsubscribeRoot = runtime.subscribeRoot((committedContainer, batches) => {
      if (committedContainer === container) runtime.runInBatch(batches[0] ?? 0, bump);
    });
    return () => {
      unsubscribeNode();
      unsubscribeRoot();
    };
  }, [container, node, runtime]);
  return runtime.committed(node, container);
}

export function startTransitionWrite(scope: () => void): void {
  register();
  React.startTransition(scope);
}

export function useAtom<T>(initial: T | (() => T), options?: AtomOptions<T>): Atom<T> {
  const runtime = getRuntime();
  const [value] = React.useState(() => runtime.atom(initial, options));
  return value;
}

export function useAtomValue<T>(initial: T | (() => T), options?: AtomOptions<T>): T {
  return useValue(useAtom(initial, options));
}
