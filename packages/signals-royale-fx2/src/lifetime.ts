/**
 * Lifetime effects: an atom option that runs setup when the atom gains its
 * first subscriber of ANY kind (computed chain, effect, or React component)
 * and runs the returned cleanup when the last subscriber of every kind is
 * gone. Exactly one observation is active across the union of kinds.
 *
 * Transitions within one tick coalesce through a microtask, so
 * subscribe/unsubscribe flaps (StrictMode double-mounts, list reorders)
 * net out instead of bouncing the resource.
 */

import {
  type CellNode,
  type ReactiveNode,
  Flags,
  hooks,
  peekCell,
  untracked,
  writeCell,
} from './graph.ts';

/** Host microtask scheduler (present in every supported runtime; typed here
 * so the engine's type surface stays lib-agnostic). */
declare const queueMicrotask: (fn: () => void) => void;

const pending = new Set<CellNode<unknown>>();
let scheduled = false;

function onObservation(node: ReactiveNode, _on: boolean): void {
  if ((node.flags & Flags.Cell) === 0) return;
  const cell = node as CellNode<unknown>;
  if (cell.lifetime === undefined) return;
  pending.add(cell);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(flushLifetimeTransitions);
  }
}

/** Settle observation state now (also called from tests). */
export function flushLifetimeTransitions(): void {
  scheduled = false;
  const cells = [...pending];
  pending.clear();
  for (const cell of cells) {
    const shouldBeActive = cell.observerCount > 0;
    if (shouldBeActive === cell.lifetimeActive) continue;
    cell.lifetimeActive = shouldBeActive;
    if (shouldBeActive) {
      const ctx = {
        get: () => untracked(() => peekCell(cell)),
        set: (v: unknown) => {
          writeCell(cell, v);
        },
      };
      const cleanup = cell.lifetime!(ctx);
      cell.lifetimeCleanup = typeof cleanup === 'function' ? cleanup : undefined;
    } else {
      const cleanup = cell.lifetimeCleanup;
      cell.lifetimeCleanup = undefined;
      if (cleanup !== undefined) untracked(cleanup);
    }
  }
}

export function installLifetimeHook(): void {
  hooks.observation = onObservation;
}
