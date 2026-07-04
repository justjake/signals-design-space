// SP-F8 event-overhead benchmark. One VARIANT per process (repo methodology:
// same-process suite runs are order-biased/megamorphic).
// Usage: node bench.mjs <variant>
//   native      plain async fns (feature ABSENT baseline)
//   dual        twin-build dispatch wrapper, no action running (feature PRESENT, unarmed)
//   dual-armed  twin-build wrapper, every event inside startAction (in-action cost)
//   gen         generator driver unconditionally (whole-app compile worst case), unarmed
//   als         Node AsyncLocalStorage reference: native fns under als.run per event
import { getToken, startAction, asyncToGen } from "./carrier.mjs";
import { AsyncLocalStorage } from "node:async_hooks";

const EVENTS = 1000;
const ITERS = 20;
const WARMUP = 5;

const deferMicro = (v) => new Promise((r) => queueMicrotask(() => r(v)));

// --- native impls ------------------------------------------------------
async function subNative(x) {
  return await deferMicro(x + 1);
}
async function handlerNative(i) {
  let x = i;
  for (let j = 0; j < 25; j++) {
    x = await Promise.resolve(x + 1); // resolved native promise
    x = await deferMicro(x); // microtask-deferred
    if (j % 5 === 0) x = await subNative(x); // nested async call
  }
  return x;
}

// --- twin-build (dual) impls: every async fn = { native body, gen body,
// dispatch wrapper }; call sites hit the wrapper --------------------------
const subGen = asyncToGen(function* (x) {
  return yield deferMicro(x + 1);
});
function subDual(x) {
  return getToken() === null ? subNative(x) : subGen(x);
}
async function handlerDualNativeBody(i) {
  let x = i;
  for (let j = 0; j < 25; j++) {
    x = await Promise.resolve(x + 1);
    x = await deferMicro(x);
    if (j % 5 === 0) x = await subDual(x);
  }
  return x;
}
const handlerGenBody = asyncToGen(function* (i) {
  let x = i;
  for (let j = 0; j < 25; j++) {
    x = yield Promise.resolve(x + 1);
    x = yield deferMicro(x);
    if (j % 5 === 0) x = yield subDual(x);
  }
  return x;
});
function handlerDual(i) {
  return getToken() === null ? handlerDualNativeBody(i) : handlerGenBody(i);
}

// --- ALS reference -----------------------------------------------------
const als = new AsyncLocalStorage();

const TOKEN = { id: 1 };
const variants = {
  native: (i) => handlerNative(i),
  dual: (i) => handlerDual(i),
  "dual-armed": (i) => startAction(TOKEN, () => handlerDual(i)),
  gen: (i) => handlerGenBody(i),
  als: (i) => als.run(TOKEN, () => handlerNative(i)),
};

const name = process.argv[2];
const fn = variants[name];
if (!fn) {
  console.error("unknown variant", name);
  process.exit(2);
}

let sink = 0;
const perEventUs = [];
for (let it = 0; it < ITERS; it++) {
  const t0 = performance.now();
  for (let e = 0; e < EVENTS; e++) sink += await fn(e);
  const dt = performance.now() - t0;
  if (it >= WARMUP) perEventUs.push((dt * 1000) / EVENTS);
}
console.log(JSON.stringify({ variant: name, perEventUs, sink }));
