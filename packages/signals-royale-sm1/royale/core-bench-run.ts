// @ts-nocheck
import adapter from "./milomg-adapter.ts";
import { kairoBench } from "../../../milomg-reactivity-benchmark/packages/core/src/benches/kairoBench.ts";
import { cellxbench } from "../../../milomg-reactivity-benchmark/packages/core/src/benches/cellxBench.ts";
import { dynamicBench } from "../../../milomg-reactivity-benchmark/packages/core/src/benches/reactively/dynamicBench.ts";

const requested = process.argv[2] ?? "kairo";
const log = (result) => console.log(`${requested},${result.test},${result.time.toFixed(2)}`);
const framework = {
  name: adapter.name,
  signal(initialValue) {
    const signal = adapter.createSignal(initialValue);
    return {
      read: () => adapter.readSignal(signal),
      write: (value) => adapter.writeSignal(signal, value),
    };
  },
  computed(fn) {
    const value = adapter.createComputed(fn);
    return { read: () => adapter.readComputed(value) };
  },
  effect: adapter.effect,
  withBatch: adapter.withBatch,
  withBuild: adapter.withBuild,
  cleanup: adapter.cleanup,
};

if (requested === "kairo") await kairoBench([{ framework }], log);
else if (requested === "cellx") await cellxbench([{ framework }], log);
else if (requested === "dynamic") {
  await dynamicBench([{ framework, testPullCounts: true }], log);
} else throw new Error(`Unknown suite: ${requested}`);
