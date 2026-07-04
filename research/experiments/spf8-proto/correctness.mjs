// SP-F8 correctness matrix. Run: node correctness.mjs
import {
  getToken,
  startAction,
  asyncToGen,
  asyncGenToGen,
  awaitG,
} from "./carrier.mjs";

let pass = 0,
  fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.log("FAIL:", name);
  }
}
const defer = (v, ms = 0) => new Promise((r) => setTimeout(() => r(v), ms));

// 1. plain await chain (depth 50)
const chain = asyncToGen(function* (T) {
  for (let i = 0; i < 50; i++) {
    yield Promise.resolve(i);
    check(`chain[${i}] token`, getToken() === T);
  }
  return getToken();
});

// 2. Promise.all of compiled + native promises
const inner = asyncToGen(function* (T) {
  yield defer(1);
  check("all/inner post-await token", getToken() === T);
  return getToken();
});
const overAll = asyncToGen(function* (T) {
  const r = yield Promise.all([inner(T), Promise.resolve(2), defer(3)]);
  check("all post-await token", getToken() === T);
  check("all inner returned token", r[0] === T);
  return getToken();
});

// 3. setTimeout-wrapped resolution
const timered = asyncToGen(function* (T) {
  yield new Promise((r) => setTimeout(r, 1));
  check("setTimeout post-await token", getToken() === T);
  yield defer(0, 2);
  check("setTimeout chain 2 token", getToken() === T);
  return getToken();
});

// 4. async generator + for-await
const agen = asyncGenToGen(function* (T) {
  yield awaitG(defer(1)); // await
  check("agen post-await token", getToken() === T);
  yield 10; // yield
  check("agen post-yield token", getToken() === T);
  yield awaitG(Promise.resolve(2));
  yield 20;
});
const consumeAgen = asyncToGen(function* (T) {
  const out = [];
  const it = agen(T);
  let r;
  while (!(r = yield it.next()).done) {
    check("agen consumer between yields token", getToken() === T);
    out.push(r.value);
  }
  return out.join(",");
});

// 5. finally-restore under thrown rejections
const thrower = asyncToGen(function* (T) {
  try {
    yield Promise.reject(new Error("boom"));
    check("unreachable", false);
  } catch (e) {
    check("catch-after-rejection token", getToken() === T);
  } finally {
    check("finally token", getToken() === T);
  }
  // rethrow path: rejection escapes the async fn
  yield Promise.resolve(1);
  throw new Error("escape");
});

// 6. two interleaved actions must not bleed tokens
const interleaved = (T) =>
  asyncToGen(function* () {
    const seen = [];
    for (let i = 0; i < 20; i++) {
      yield defer(0, Math.random() < 0.5 ? 0 : 1);
      seen.push(getToken());
    }
    return seen.every((t) => t === T);
  })();

// 7. global then-patch counterexample: await of a NATIVE promise does not
//    go through the public Promise.prototype.then, so a then-patch carrier
//    cannot restore identity across ordinary `await`.
async function thenPatchProbe() {
  const origThen = Promise.prototype.then;
  let patchCalls = 0;
  Promise.prototype.then = function (...a) {
    patchCalls++;
    return origThen.apply(this, a);
  };
  try {
    await Promise.resolve(1); // native await of native promise
    const nativeAwaitSeen = patchCalls;
    await { then: (r) => r(1) }; // bare thenable: its OWN then is called
    const thenableSeen = patchCalls - nativeAwaitSeen;
    Promise.resolve(1).then(() => {}); // explicit .then() call
    const explicitSeen = patchCalls - nativeAwaitSeen - thenableSeen;
    check("then-patch misses native await", nativeAwaitSeen === 0);
    check("then-patch misses bare thenables too", thenableSeen === 0);
    check("then-patch only sees explicit .then calls", explicitSeen === 1);
  } finally {
    Promise.prototype.then = origThen;
  }
}

const main = async () => {
  const A = { name: "A" },
    B = { name: "B" };

  check("chain", (await startAction(A, () => chain(A))) === A);
  check("ambient restored after chain", getToken() === null);

  check("Promise.all", (await startAction(A, () => overAll(A))) === A);
  check("setTimeout", (await startAction(A, () => timered(A))) === A);
  check(
    "async generator",
    (await startAction(A, () => consumeAgen(A))) === "10,20",
  );

  let escaped = null;
  await startAction(A, () => thrower(A)).catch((e) => (escaped = e.message));
  check("rejection escapes with message", escaped === "escape");
  check("ambient restored after rejection", getToken() === null);

  const [okA, okB] = await Promise.all([
    startAction(A, () => interleaved(A)),
    startAction(B, () => interleaved(B)),
  ]);
  check("interleaved action A isolated", okA === true);
  check("interleaved action B isolated", okB === true);
  check("ambient null at end", getToken() === null);

  await thenPatchProbe();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};
main();
