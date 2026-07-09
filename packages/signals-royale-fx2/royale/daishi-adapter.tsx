/** Daishi tearing-matrix adapter: three hooks over one module-level store. */
import { signal, update } from 'signals-royale-fx2';
import { registerReactSignals, useValue } from '../src/react/index.ts';

registerReactSignals();

const count = signal(0);

const increment = (): void => {
  update(count, (x) => x + 1);
};
const double = (): void => {
  update(count, (x) => x * 2);
};

export default {
  useCount(): number {
    return useValue(count);
  },
  useIncrement(): () => void {
    return increment;
  },
  useDouble(): () => void {
    return double;
  },
};
