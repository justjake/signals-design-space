import * as React from 'react';
import { getRuntime, register, useValue } from '../src/index';

register();
const count = getRuntime().atom(0);

export default {
  useCount(): number {
    return useValue(count);
  },
  useIncrement(): () => void {
    return React.useCallback(() => count.update((value) => value + 1), []);
  },
  useDouble(): () => void {
    return React.useCallback(() => count.update((value) => value * 2), []);
  },
};
