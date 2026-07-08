import "../../react-seam-bench/src/scenarios/dom.ts";
import * as React from "react";
import sm2 from "../royale/seam-bench-adapter.ts";
import fanout from "../../react-seam-bench/src/scenarios/fanout.ts";
import mount from "../../react-seam-bench/src/scenarios/mount.ts";
import transition from "../../react-seam-bench/src/scenarios/transition.tsx";
import type { Contender } from "../../react-seam-bench/src/adapters/types.ts";

const stock: Contender = {
  name: "uses-store",
  createCells(count) {
    const values = new Int32Array(count);
    const listeners: Array<Set<() => void> | undefined> = new Array(count);
    return {
      useCell(index) {
        return React.useSyncExternalStore(
          (listener) => {
            const set = (listeners[index] ??= new Set());
            set.add(listener);
            return () => set.delete(listener);
          },
          () => values[index],
        );
      },
      writeCell(index, value) {
        values[index] = value;
        const set = listeners[index];
        if (set !== undefined) for (const listener of set) listener();
      },
      writeMany(updates) {
        for (const [index, value] of updates) values[index] = value;
        for (const [index] of updates) {
          const set = listeners[index];
          if (set !== undefined) for (const listener of set) listener();
        }
      },
      writeManyInTransition(updates) {
        React.startTransition(() => this.writeMany(updates));
      },
      dispose() {},
    };
  },
};

const scenarios = { fanout, transition, mount };
const contenders = { sm2, stock };
const scenarioName = process.argv[2] as keyof typeof scenarios;
const contenderName = process.argv[3] as keyof typeof contenders;
const scenario = scenarios[scenarioName];
const contender = contenders[contenderName];
if (scenario === undefined || contender === undefined) process.exit(2);

await scenario.run(contender, (milliseconds) => {
  const stat =
    scenarioName === "fanout"
      ? "median_write_to_commit"
      : scenarioName === "transition"
      ? "urgent_p95"
      : "median_mount";
  console.log(
    `${scenarioName},${contender.name},${stat},${milliseconds.toFixed(2)}`,
  );
});
