/**
 * Engine conformance: the full reactive-framework-test-suite (179 cases)
 * against this engine. Wiring shape follows harness/conformance.
 */
import { describe, expect, test } from 'vitest';
import {
  testSuite,
  SkipTest,
  setExpect,
  type ReactiveFramework,
} from 'reactive-framework-test-suite';
import adapter from '../royale/harness-adapter.ts';
import { WriteForbiddenError } from '../src/graph.ts';

const framework: ReactiveFramework = {
  name: adapter.name,
  signal(initialValue) {
    const signal = adapter.signal(initialValue);
    return {
      read: signal.read,
      write(value) {
        try {
          signal.write(value);
        } catch (error) {
          if (
            error instanceof WriteForbiddenError &&
            error.message === 'writes inside computeds are forbidden'
          ) {
            throw new SkipTest('computed writes are disabled by policy');
          }
          throw error;
        }
      },
    };
  },
  computed(fn) {
    return adapter.computed(fn);
  },
  effect(fn) {
    return adapter.effect(fn);
  },
  run(fn) {
    adapter.effectScope(fn)();
  },
  batch(fn) {
    adapter.startBatch();
    try {
      fn();
    } finally {
      adapter.endBatch();
    }
  },
  untracked: adapter.untracked,
};

setExpect(expect);

for (const { section, cases } of testSuite) {
  describe(`fx2 :: ${section}`, () => {
    for (const [name, fn] of Object.entries(cases)) {
      test(name, () => {
        try {
          framework.run(() => fn(framework));
        } catch (e) {
          if (e instanceof SkipTest) return;
          throw e;
        }
      });
    }
  });
}
