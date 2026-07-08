import { describe, expect, test } from "vitest";
import {
  SkipTest,
  setExpect,
  testSuite,
  type ReactiveFramework,
} from "reactive-framework-test-suite";
import adapter from "../royale/harness-adapter";

setExpect(expect);
const framework: ReactiveFramework = {
  ...adapter,
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
};

for (const { section, cases } of testSuite) {
  describe(section, () => {
    for (const [name, fn] of Object.entries(cases)) {
      test(name, () => {
        try {
          framework.run(() => fn(framework));
        } catch (error) {
          if (!(error instanceof SkipTest)) throw error;
        }
      });
    }
  });
}
