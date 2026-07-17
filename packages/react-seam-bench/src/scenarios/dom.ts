/**
 * Hand-rolled DOM globals instead of a test-runner environment: react-dom
 * only needs window/document/navigator to exist when it evaluates and a
 * real document at createRoot() time. Timers and microtasks stay Node's
 * own — the benchmark depends on real scheduling, so nothing here touches
 * setTimeout/queueMicrotask.
 *
 * This module installs a DOM at import time on purpose: it must be the
 * first import of the child entrypoint so the globals exist before
 * react-dom/client evaluates. Each scenario then calls freshDom() so nodes
 * leaked by one scenario cannot skew the next.
 */
import { JSDOM } from "jsdom"

let current: JSDOM | undefined

function define(name: string, value: unknown): void {
  // Plain assignment would throw on Node's own getter-defined globals
  // (navigator); defineProperty replaces them cleanly.
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

export function freshDom(): void {
  current?.window.close()
  current = new JSDOM("<!doctype html><html><body></body></html>")
  define("window", current.window)
  define("document", current.window.document)
  define("navigator", current.window.navigator)
}

freshDom()
