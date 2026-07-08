import { describe, expect, test } from 'vitest';
import { setExpect, SkipTest, testSuite, type ReactiveFramework } from 'reactive-framework-test-suite';
import adapter from '../royale/harness-adapter.ts';

const framework: ReactiveFramework = {
  name: adapter.name,
  signal: adapter.signal,
  computed: adapter.computed,
  effect: adapter.effect,
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
  describe(section, () => {
    for (const [name, fn] of Object.entries(cases)) {
      test(name, () => {
        try {
          framework.run(() => fn(framework));
        } catch (error) {
          if (error instanceof SkipTest) return;
          throw error;
        }
      });
    }
  });
}
