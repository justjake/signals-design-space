import { useCallback } from 'react';
import { atom, update, useValue } from '../src/index.js';

const count = atom(0);

export default {
	useCount: () => useValue(count),
	useIncrement: () => useCallback(() => update(count, value => value + 1), []),
	useDouble: () => useCallback(() => update(count, value => value * 2), []),
};
