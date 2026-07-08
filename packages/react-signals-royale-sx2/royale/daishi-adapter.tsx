import * as React from "react";
import { atom } from "signals-royale-sx2";
import { reduce, register, startTransitionWrite, useValue } from "../src/index";

const count = atom(0);
register();

export default {
  useCount(): number {
    return useValue(count);
  },
  useIncrement(): () => void {
    return React.useCallback(() => reduce(count, (value) => value + 1), []);
  },
  useDouble(): () => void {
    return React.useCallback(
      () => startTransitionWrite(() => reduce(count, (value) => value * 2)),
      [],
    );
  },
};
