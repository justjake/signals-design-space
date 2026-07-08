/**
 * SignalScope: the per-root world carrier.
 *
 * Its reducer state is the set of transition draft ids this root has been
 * told about (plus a revision counter, below). Because every draft dispatch
 * happens inside its transition's scope, React's own update queues decide
 * which render passes see which ids: urgent passes skip pending transition
 * updates (world = committed base), the transition's own passes include
 * them, and a rebased retry recomputes the same queue over new state. That
 * IS the render-pass world definition — no lane bookkeeping of our own.
 *
 * The revision counter handles one hazard: a write appended to a draft
 * AFTER some pass already rendered that draft (an async transition writing
 * across awaits). The host re-dispatches the draft id; the reducer returns
 * a fresh state object even though the id set is unchanged, which makes
 * React re-render the transition's passes against the completed batch —
 * a pass never commits half a batch.
 *
 * On each commit the scope records its committed world per container (the
 * per-root committed view) and confirms the drafts it carried; when every
 * root that received a draft has committed it, the draft retires (folds
 * into canonical state).
 */
import * as React from 'react';
import { reactIntegration as engine, type DraftId } from 'signals-royale-fx2';
import {
  confirmCommit,
  markDraftRendered,
  registerProvider,
  type ProviderRecord,
} from './host.ts';

export interface WorldState {
  ids: readonly DraftId[];
  rev: number;
}

const EMPTY_WORLD: WorldState = { ids: [], rev: 0 };

export const WorldContext = React.createContext<WorldState>(EMPTY_WORLD);
export const ContainerContext = React.createContext<object | null>(null);

function worldsReducer(prev: WorldState, id: DraftId): WorldState {
  if (prev.ids.includes(id)) return { ids: prev.ids, rev: prev.rev + 1 };
  return { ids: [...prev.ids, id], rev: prev.rev + 1 };
}

export interface SignalScopeProps {
  container?: object;
  children?: React.ReactNode;
}

export function SignalScope(props: SignalScopeProps): React.ReactElement {
  const [world, dispatch] = React.useReducer(worldsReducer, EMPTY_WORLD);
  const container = props.container ?? null;
  // A pass carrying these drafts is being rendered; late appends to them
  // must re-dispatch (see module comment).
  for (const id of world.ids) markDraftRendered(id);
  const record = React.useMemo<ProviderRecord>(
    () => ({ dispatch, container }),
    [dispatch, container],
  );
  React.useLayoutEffect(() => registerProvider(record), [record]);
  React.useLayoutEffect(() => {
    // Runs exactly at this root's commits of world-carrying passes.
    engine.traceNode('root-commit', null, 0, { world: world.ids });
    confirmCommit(record, world.ids);
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
