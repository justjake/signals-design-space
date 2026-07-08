/**
 * SignalScope: the per-root world carrier.
 *
 * Its reducer state is the list of transition draft ids this root has been
 * told about. Because every draft dispatch happens inside its transition's
 * scope, React's own update queues decide which render passes see which
 * ids: urgent passes skip pending transition updates (world = committed
 * base), the transition's own passes include them, and a rebased retry
 * recomputes the same queue over new state. That IS the render-pass world
 * definition — no lane bookkeeping of our own.
 *
 * On each commit the scope records its committed world per container (the
 * per-root committed view) and confirms the drafts it carried; when every
 * root that received a draft has committed it, the draft retires (folds
 * into canonical state).
 */
import * as React from 'react';
import { reactIntegration as engine, type DraftId } from 'signals-royale-fx2';
import { confirmCommit, registerProvider, type ProviderRecord } from './host.ts';

const EMPTY_WORLD: readonly DraftId[] = [];

export const WorldContext = React.createContext<readonly DraftId[]>(EMPTY_WORLD);
export const ContainerContext = React.createContext<object | null>(null);

function worldsReducer(prev: readonly DraftId[], id: DraftId): readonly DraftId[] {
  if (prev.includes(id)) return prev;
  return [...prev, id];
}

export interface SignalScopeProps {
  container?: object;
  children?: React.ReactNode;
}

export function SignalScope(props: SignalScopeProps): React.ReactElement {
  const [world, dispatch] = React.useReducer(worldsReducer, EMPTY_WORLD);
  const container = props.container ?? null;
  const record = React.useMemo<ProviderRecord>(
    () => ({ dispatch, container }),
    [dispatch, container],
  );
  React.useLayoutEffect(() => registerProvider(record), [record]);
  React.useLayoutEffect(() => {
    // Runs exactly at this root's commits of world-carrying passes.
    engine.traceNode('root-commit', null, 0, { world });
    confirmCommit(record, world);
  }, [record, world]);
  return React.createElement(
    ContainerContext.Provider,
    { value: container },
    React.createElement(WorldContext.Provider, { value: world }, props.children),
  );
}

export interface WrappedRoot {
  render(node: unknown): void;
  unmount(): void;
}

/**
 * A createRoot with the scope pre-installed: every render() is wrapped in
 * this root's SignalScope, so apps (and the shared battery) get transition
 * worlds and per-root committed views without composing anything.
 */
export function wrapCreateRoot(
  createRoot: (el: Element, opts?: unknown) => { render(node: unknown): void; unmount(): void },
): (el: Element, opts?: unknown) => WrappedRoot {
  return (el, opts) => {
    const root = createRoot(el, opts);
    return {
      render(node: unknown) {
        root.render(
          React.createElement(SignalScope, { container: el }, node as React.ReactNode),
        );
      },
      unmount() {
        root.unmount();
      },
    };
  };
}
