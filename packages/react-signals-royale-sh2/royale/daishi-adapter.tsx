import { useCallback } from 'react';
import { atom, read, set, update, useValue } from '../src';

const count = atom(0);
const increment = () => update(count, value => value + 1);
const double = () => set(count, read(count) * 2);

export default {
  useCount: () => useValue(count),
  useIncrement: () => useCallback(increment, []),
  useDouble: () => useCallback(double, []),
};
