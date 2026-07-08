// @ts-nocheck
import adapter from "./milomg-adapter.ts";
import { kairoBench } from "../../../milomg-reactivity-benchmark/packages/core/src/benches/kairoBench.ts";
import { cellxbench } from "../../../milomg-reactivity-benchmark/packages/core/src/benches/cellxBench.ts";
import { dynamicBench } from "../../../milomg-reactivity-benchmark/packages/core/src/benches/reactively/dynamicBench.ts";
import { debugState } from "../src/index.ts";

const requested = process.argv[2] ?? "kairo";
const log = (result) => console.log(`${requested},${result.test},${result.time.toFixed(2)}`);
const framework = adapter;

if (requested === "kairo") await kairoBench([{ framework }], log);
else if (requested === "cellx") await cellxbench([{ framework }], log);
else if (requested === "dynamic") {
  await dynamicBench([{ framework, testPullCounts: true }], log);
} else throw new Error(`Unknown suite: ${requested}`);

const state = debugState();
const leaked =
  state.batches !== 0 || state.passes !== 0 || state.touchedAtoms !== 0 || state.liveLanes !== 0;
console.error(`# leak ${leaked ? "yes" : "no"} ${JSON.stringify(state)}`);
if (leaked) process.exitCode = 1;
