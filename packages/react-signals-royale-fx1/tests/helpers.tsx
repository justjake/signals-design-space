/**
 * Shared harness for the real-React suites: registration, per-test engine
 * reset, root management, act plumbing.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { register, resetForTest, type RuntimeHandle } from '../src/runtime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Harness {
  handle: RuntimeHandle;
  roots: Root[];
  containers: HTMLElement[];
  newRoot(): { root: Root; container: HTMLElement };
  mount(node: React.ReactNode): Promise<{ root: Root; container: HTMLElement }>;
  text(container: HTMLElement): string;
  cleanup(): Promise<void>;
}

export function makeHarness(): Harness {
  const handle = register();
  resetForTest();
  const roots: Root[] = [];
  const containers: HTMLElement[] = [];
  const h: Harness = {
    handle,
    roots,
    containers,
    newRoot() {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      roots.push(root);
      containers.push(container);
      return { root, container };
    },
    async mount(node) {
      const made = h.newRoot();
      await act(() => {
        made.root.render(node);
      });
      return made;
    },
    text(container) {
      return (container.textContent ?? '').replace(/\s+/g, '');
    },
    async cleanup() {
      await act(async () => {
        for (const r of roots) r.unmount();
      });
      for (const c of containers) c.remove();
      const errors = [...handle.errors];
      resetForTest();
      if (errors.length > 0) throw errors[0];
    },
  };
  return h;
}

export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; settled: boolean } {
  let resolve!: (v: T) => void;
  const d = {
    promise: undefined as unknown as Promise<T>,
    resolve: (v: T) => {
      d.settled = true;
      resolve(v);
    },
    settled: false,
  };
  d.promise = new Promise<T>((res) => {
    resolve = res;
  });
  return d;
}

export { act };
