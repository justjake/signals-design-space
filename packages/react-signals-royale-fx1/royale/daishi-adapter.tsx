/**
 * Daishi tearing-matrix adapter: three hooks over one module-level counter.
 */
import { useCallback } from "react";
import { atom } from "signals-royale-fx1";
import { register } from "../src/runtime";
import { useValue } from "../src/hooks";

register();

const count = atom(0, { label: "daishi-count" });

export default {
  useCount(): number {
    return useValue(count);
  },
  useIncrement(): () => void {
    return useCallback(() => {
      count.update((c) => c + 1);
    }, []);
  },
  useDouble(): () => void {
    return useCallback(() => {
      count.update((c) => c * 2);
    }, []);
  },
};
