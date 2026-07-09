import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import React, { startTransition, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { atom, read, register, startTransitionWrite, useValue } from "../src/index.ts";

const scenarios = ["fanout", "transition", "mount"];
const contenders = ["sh1", "useSyncExternalStore"];
const scenario = process.argv[2];
const contender = process.argv[3];

if (scenario === undefined) {
  const executable = `${process.cwd()}/node_modules/.bin/tsx`;
  const file = fileURLToPath(import.meta.url);
  for (const name of scenarios) {
    for (const implementation of contenders) {
      const result = spawnSync(executable, [file, name, implementation], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      if (result.status !== 0) process.exit(result.status ?? 1);
      process.stdout.write(result.stdout);
    }
  }
  process.exit(0);
}

if (!scenarios.includes(scenario) || !contenders.includes(contender)) {
  throw new Error("usage: react-bench.mjs [fanout|transition|mount] [sh1|useSyncExternalStore]");
}

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16);
globalThis.cancelAnimationFrame = clearTimeout;

let registration;
if (contender === "sh1") registration = register();

function createStock(value = 0) {
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function makeCells(count) {
  const cells = [];
  for (let index = 0; index < count; index++) {
    cells.push(contender === "sh1" ? atom(0) : createStock());
  }
  return cells;
}

function valueOf(cell) {
  return contender === "sh1"
    ? useValue(cell)
    : useSyncExternalStore(cell.subscribe, cell.get, cell.get);
}

function setCell(cell, value) {
  if (contender === "sh1") cell.set(value);
  else cell.set(value);
}

function percentile(samples, fraction) {
  samples.sort((a, b) => a - b);
  return samples[Math.ceil(samples.length * fraction) - 1];
}

function container() {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

async function fanout() {
  const cells = makeCells(5000);
  let mounted;
  const ready = new Promise((resolve) => (mounted = resolve));
  let pending;
  function Row({ cell, index }) {
    const value = valueOf(cell);
    useLayoutEffect(() => {
      if (pending?.index === index) {
        const done = pending;
        pending = undefined;
        done.resolve(performance.now() - done.started);
      }
    }, [value]);
    return React.createElement("span", null, value);
  }
  function App() {
    useLayoutEffect(mounted, []);
    const rows = [];
    for (let index = 0; index < cells.length; index++) {
      rows.push(React.createElement(Row, { cell: cells[index], index, key: index }));
    }
    return React.createElement("div", null, rows);
  }
  const root = createRoot(container());
  root.render(React.createElement(App));
  await ready;
  const samples = [];
  for (let iteration = 1; iteration <= 200; iteration++) {
    const index = (iteration * 7919) % cells.length;
    const sample = new Promise((resolve) => {
      pending = { index, started: performance.now(), resolve };
    });
    setCell(cells[index], iteration);
    samples.push(await sample);
  }
  root.unmount();
  return percentile(samples, 0.5);
}

async function transition() {
  const cells = makeCells(2000);
  const samples = [];
  let setInput;
  let pendingUrgent;
  let mounted;
  let transitioned;
  const ready = new Promise((resolve) => (mounted = resolve));
  const transitionDone = new Promise((resolve) => (transitioned = resolve));
  function Row({ cell, first }) {
    const value = valueOf(cell);
    useLayoutEffect(() => {
      if (first && value === 1) transitioned();
    }, [first, value]);
    return React.createElement("span", null, value);
  }
  function App() {
    const [input, updateInput] = useState(0);
    setInput = updateInput;
    useLayoutEffect(() => {
      if (pendingUrgent?.value === input) {
        samples.push(performance.now() - pendingUrgent.started);
        pendingUrgent.resolve();
        pendingUrgent = undefined;
      }
    }, [input]);
    useLayoutEffect(mounted, []);
    const rows = [React.createElement("b", { key: "input" }, input)];
    for (let index = 0; index < cells.length; index++) {
      rows.push(
        React.createElement(Row, {
          cell: cells[index],
          first: index === 0,
          key: index,
        }),
      );
    }
    return React.createElement("div", null, rows);
  }
  const root = createRoot(container());
  root.render(React.createElement(App));
  await ready;
  const urgent = (async () => {
    for (let value = 1; value <= 30; value++) {
      await new Promise((resolve) => setTimeout(resolve, 16));
      const committed = new Promise((resolve) => {
        pendingUrgent = { value, started: performance.now(), resolve };
      });
      setInput(value);
      await committed;
    }
  })();
  setTimeout(() => {
    const rewrite = () => {
      for (const cell of cells) setCell(cell, 1);
    };
    if (contender === "sh1") startTransitionWrite(rewrite);
    else startTransition(rewrite);
  }, 1);
  await Promise.all([urgent, transitionDone]);
  root.unmount();
  return percentile(samples, 0.95);
}

async function mount() {
  const samples = [];
  for (let round = 0; round < 5; round++) {
    const cells = makeCells(5000);
    let committed;
    const done = new Promise((resolve) => (committed = resolve));
    function Row({ cell }) {
      return React.createElement("span", null, valueOf(cell));
    }
    function App() {
      useLayoutEffect(committed, []);
      const rows = [];
      for (let index = 0; index < cells.length; index++) {
        rows.push(React.createElement(Row, { cell: cells[index], key: index }));
      }
      return React.createElement("div", null, rows);
    }
    const element = container();
    const root = createRoot(element);
    const started = performance.now();
    root.render(React.createElement(App));
    await done;
    samples.push(performance.now() - started);
    root.unmount();
    element.remove();
  }
  return percentile(samples, 0.5);
}

const result = await { fanout, transition, mount }[scenario]();
registration?.dispose();
console.log(
  `${scenario},${contender},${scenario === "transition" ? "p95" : "median"},${result.toFixed(2)}`,
);
