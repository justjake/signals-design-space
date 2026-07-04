/**
 * Static-import twin of kairo-harness.mjs so it can be esbuild-bundled exactly
 * like harness/bench/child.ts (bundle:true, es2022, keepNames:false). Picks
 * the lib via env FRAMEWORK=arena|alien at runtime; same WARM/BENCH/REPORT
 * toggles as kairo-harness.mjs.
 *
 * Build+run (see kairo-bundle.sh):
 *   esbuild prof/kairo-entry.ts --bundle --format=esm --platform=node \
 *     --target=es2022 --outfile=/tmp/kairo-entry.mjs
 *   FRAMEWORK=arena node --expose-gc /tmp/kairo-entry.mjs
 */
import * as arenaLib from '../src/index';

import { avoidablePropagation } from '../../../milomg-reactivity-benchmark/packages/core/src/benches/kairo/avoidable';
import { broadPropagation } from '../../../milomg-reactivity-benchmark/packages/core/src/benches/kairo/broad';
import { deepPropagation } from '../../../milomg-reactivity-benchmark/packages/core/src/benches/kairo/deep';
import { diamond } from '../../../milomg-reactivity-benchmark/packages/core/src/benches/kairo/diamond';
import { mux } from '../../../milomg-reactivity-benchmark/packages/core/src/benches/kairo/mux';
import { repeatedObservers } from '../../../milomg-reactivity-benchmark/packages/core/src/benches/kairo/repeated';
import { triangle } from '../../../milomg-reactivity-benchmark/packages/core/src/benches/kairo/triangle';
import { unstable } from '../../../milomg-reactivity-benchmark/packages/core/src/benches/kairo/unstable';
import { mol } from '../../../milomg-reactivity-benchmark/packages/core/src/benches/kairo/molBench';
import { nextTick } from '../../../milomg-reactivity-benchmark/packages/core/src/util/asyncUtil';
import { fastestTest } from '../../../milomg-reactivity-benchmark/packages/core/src/util/benchRepeat';

const libName = process.env.FRAMEWORK ?? 'arena';
const lib = arenaLib as typeof arenaLib & {
	effect(fn: () => void | (() => void)): () => void;
};

const ALL = [
	{ name: 'avoidablePropagation', fn: avoidablePropagation },
	{ name: 'broadPropagation', fn: broadPropagation },
	{ name: 'deepPropagation', fn: deepPropagation },
	{ name: 'diamond', fn: diamond },
	{ name: 'mux', fn: mux },
	{ name: 'repeatedObservers', fn: repeatedObservers },
	{ name: 'triangle', fn: triangle },
	{ name: 'unstable', fn: unstable },
	{ name: 'molBench', fn: mol },
];
const pick = (env: string, dflt: typeof ALL) => {
	const v = process.env[env];
	if (!v) return dflt;
	const names = v.split(',').map((s) => s.trim());
	return ALL.filter((c) => names.includes(c.name) || names.some((n) => c.name.startsWith(n)));
};
const WARM = pick('WARM', ALL);
const BENCH = pick('BENCH', ALL);
const REPORT = pick('REPORT', BENCH);

// ---- child.ts bridge (verbatim) ----------------------------------------------

let scope: (() => void) | null = null;
const framework = {
	name: libName,
	signal: <T>(initialValue: T) => {
		const s = lib.signal(initialValue);
		return { read: () => s() as T, write: (v: T) => s(v) };
	},
	computed: <T>(fn: () => T) => {
		const c = lib.computed(fn);
		return { read: () => c() };
	},
	effect: (fn: () => void) => {
		lib.effect(() => {
			fn();
		});
	},
	withBatch: <T>(fn: () => T) => {
		lib.startBatch();
		try {
			fn();
		} finally {
			lib.endBatch();
		}
	},
	withBuild: <T>(fn: () => T): T => {
		let out!: T;
		scope = lib.effectScope(() => {
			out = fn();
		});
		return out;
	},
	cleanup: () => {
		if (scope) {
			scope();
			scope = null;
		}
	},
};

// ---- kairoBench (verbatim, minus multi-framework loop) ------------------------

async function main() {
	for (const c of WARM) {
		const iter = framework.withBuild(() => c.fn(framework));
		iter();
		iter();
		await nextTick();
		iter();
		framework.cleanup();
	}

	if (globalThis.gc) (globalThis.gc(), globalThis.gc());
	await nextTick();

	for (const c of BENCH) {
		const iter = framework.withBuild(() => {
			const iter = c.fn(framework);
			return iter;
		});

		iter();
		iter();
		await nextTick();

		iter();
		await nextTick();

		const { time } = await fastestTest(10, () => {
			for (let i = 0; i < 500; i++) {
				iter();
			}
		});

		framework.cleanup();
		if (globalThis.gc) (globalThis.gc(), globalThis.gc());

		if (REPORT.includes(c)) {
			console.log(`@@ROW ${JSON.stringify({ lib: libName, test: c.name, ms: +time.toFixed(2) })}`);
		}
	}
}

await main();
