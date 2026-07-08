// @ts-nocheck
import { freshDom } from "../../react-seam-bench/src/scenarios/dom.ts";
import contender from "./seam-bench-adapter.ts";
import { scenarios } from "../../react-seam-bench/src/scenarios/index.ts";

for (const scenario of scenarios) {
  freshDom();
  await scenario.run(contender, (milliseconds, extra) => {
    console.log(`${contender.name},${scenario.name},${milliseconds.toFixed(2)}`);
    if (extra !== undefined) console.error(`# ${scenario.name} ${JSON.stringify(extra)}`);
  });
}
