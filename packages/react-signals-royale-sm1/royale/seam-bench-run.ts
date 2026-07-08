// @ts-nocheck
import { freshDom } from "../../react-seam-bench/src/scenarios/dom.ts";
import { debugState } from "signals-royale-sm1";
import contender from "./seam-bench-adapter.ts";
import { scenarios } from "../../react-seam-bench/src/scenarios/index.ts";

for (const scenario of scenarios) {
  freshDom();
  await scenario.run(contender, (milliseconds, extra) => {
    console.log(`${contender.name},${scenario.name},${milliseconds.toFixed(2)}`);
    if (extra !== undefined) console.error(`# ${scenario.name} ${JSON.stringify(extra)}`);
  });
}

const state = debugState();
const leaked =
  state.batches !== 0 || state.passes !== 0 || state.touchedAtoms !== 0 || state.liveLanes !== 0;
console.error(`# leak ${leaked ? "yes" : "no"} ${JSON.stringify(state)}`);
if (leaked) process.exitCode = 1;
