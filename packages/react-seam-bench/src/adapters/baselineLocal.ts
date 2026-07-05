/**
 * The "if state were local" floor: each cell component owns a useState and
 * registers its setter in a module-level array, so writes from outside
 * React call the owning component's setter directly — only that component
 * re-renders. writeMany relies on React's automatic batching (all setter
 * calls happen in one synchronous task, so React renders once); the
 * transition path wraps the setter loop in startTransition, and native
 * state — unlike useSyncExternalStore stores — does participate in
 * transitions.
 */
import { startTransition, useEffect, useState } from 'react';
import type { Contender } from './types.js';

const baselineLocal: Contender = {
	name: 'baseline-local',
	createCells(n) {
		const setters: Array<((v: number) => void) | undefined> = new Array(n);

		function requireSetter(i: number): (v: number) => void {
			const set = setters[i];
			if (set === undefined) throw new Error(`baseline-local: cell ${i} is not mounted`);
			return set;
		}

		return {
			useCell(i: number): number {
				const [v, setV] = useState(0);
				// Registration waits for the passive effect (post-commit);
				// scenarios settle and drain after mounting before writing.
				useEffect(() => {
					setters[i] = setV;
					return () => {
						if (setters[i] === setV) setters[i] = undefined;
					};
				}, [i, setV]);
				return v;
			},
			writeCell: (i, v) => requireSetter(i)(v),
			writeMany(updates) {
				for (const [i, v] of updates) requireSetter(i)(v);
			},
			writeManyInTransition(updates) {
				startTransition(() => {
					for (const [i, v] of updates) requireSetter(i)(v);
				});
			},
			dispose() {
				setters.length = 0;
			},
		};
	},
};

export default baselineLocal;
