import adapter from "./milomg-adapter";
import type { PerfResult } from "../../../milomg-reactivity-benchmark/packages/core/src/util/perfLogging";
import { kairoBench } from "../../../milomg-reactivity-benchmark/packages/core/src/benches/kairoBench";
import { cellxbench } from "../../../milomg-reactivity-benchmark/packages/core/src/benches/cellxBench";
import { dynamicBench } from "../../../milomg-reactivity-benchmark/packages/core/src/benches/reactively/dynamicBench";
import type { ReactiveFramework } from "../../../milomg-reactivity-benchmark/packages/core/src/util/reactiveFramework";

const framework: ReactiveFramework = {
  name: adapter.name,
  signal<T>(initialValue: T) {
    const value = adapter.createSignal(initialValue);
    return {
      read: () => adapter.readSignal(value) as T,
      write: (next) => adapter.writeSignal(value, next),
    };
  },
  computed<T>(fn: () => T) {
    const value = adapter.createComputed(fn);
    return { read: () => adapter.readComputed(value) as T };
  },
  effect: adapter.effect,
  withBatch: adapter.withBatch,
  withBuild: adapter.withBuild,
  cleanup: adapter.cleanup,
};

function log(result: PerfResult): void {
  console.log(`${result.test},${result.time.toFixed(2)}`);
}

console.log("test,time_ms");
const suite = process.env.SM2_BENCH ?? "all";
if (suite === "all" || suite === "kairo") await kairoBench([{ framework }], log);
if (suite === "all" || suite === "cellx") await cellxbench([{ framework }], log);
if (suite === "all" || suite === "dynamic") {
  await dynamicBench([{ framework, testPullCounts: true }], log);
}
