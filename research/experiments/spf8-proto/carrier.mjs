// SP-F8 continuation-carrier prototype.
// Mechanism: dynamically-scoped token + bundler async-to-generator driver.
// The driver is exactly Babel's _asyncToGenerator shape with a token
// captured at async-resource creation (generator instantiation), pushed
// before every continuation (gen.next/.throw), and finally-restored.

let currentToken = null;
export const getToken = () => currentToken;

// Action scope entry: token live for the sync prefix; compiled async fns
// created inside capture it.
export function startAction(token, fn) {
  const prev = currentToken;
  currentToken = token;
  try {
    return fn();
  } finally {
    currentToken = prev;
  }
}

// --- async function driver (bundler output shape) ---------------------
export function asyncToGen(genFn) {
  return function (...args) {
    const token = currentToken; // captured at async-resource creation
    const gen = genFn.apply(this, args);
    return new Promise((resolve, reject) => {
      function step(method, arg) {
        let result;
        const prev = currentToken;
        currentToken = token; // pushed before the continuation
        try {
          result = gen[method](arg);
        } finally {
          currentToken = prev; // finally-restored (also on throw)
        }
        // (a throw in gen[method] propagates: rejected via the outer
        //  wrapper below on first step, or caught by stepThrow/stepNext)
        if (result.done) resolve(result.value);
        else Promise.resolve(result.value).then(stepNext, stepThrow);
      }
      function stepNext(v) {
        try {
          step("next", v);
        } catch (e) {
          reject(e);
        }
      }
      function stepThrow(e) {
        try {
          step("throw", e);
        } catch (err) {
          reject(err);
        }
      }
      stepNext(undefined);
    });
  };
}

// --- async generator driver (minimal; proves identity, not perf) ------
class AwaitMark {
  constructor(v) {
    this.v = v;
  }
}
export const awaitG = (v) => new AwaitMark(v); // compiled form of `await` in async gens

export function asyncGenToGen(genFn) {
  return function (...args) {
    const token = currentToken;
    const gen = genFn.apply(this, args);
    const step = (method, arg) =>
      new Promise((resolve, reject) => {
        const run = (m, a) => {
          let r;
          const prev = currentToken;
          currentToken = token;
          try {
            r = gen[m](a);
          } catch (e) {
            currentToken = prev;
            reject(e);
            return;
          } finally {
            currentToken = prev;
          }
          if (!r.done && r.value instanceof AwaitMark) {
            Promise.resolve(r.value.v).then(
              (v) => run("next", v),
              (e) => run("throw", e),
            );
          } else {
            resolve({ value: r.value, done: r.done });
          }
        };
        run(method, arg);
      });
    return {
      next: (v) => step("next", v),
      throw: (e) => step("throw", e),
      return: (v) => Promise.resolve({ value: v, done: true }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
}
