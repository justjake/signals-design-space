/**
 * Bench child process: runs milomg-reactivity-benchmark suites for ONE
 * framework, importing the benchmark code directly from the submodule's
 * TypeScript source. bench/run.ts bundles this file with esbuild
 * (keepNames OFF — see util/cli.ts bundleChild for why) and spawns:
 *
 *   node --expose-gc <bundled child>.mjs
 *
 * env: FRAMEWORK (adapter name), SUITES (csv of kairo,sbench,cellx,dynamic).
 * Result rows print to stdout as `@@ROW {"suite","framework","test","time"}`;
 * progress and console.assert noise go to stderr.
 *
 * Note: only the bench modules + util/ are imported from the submodule; they
 * do not import any framework packages (verified 2026-07-03).
 */
import { loadAdapter } from '../adapters/index';
import type { FrameworkAdapter } from '../adapters/types';
import type { ReactiveFramework } from '../../milomg-reactivity-benchmark/packages/core/src/util/reactiveFramework';
import type { PerfResult } from '../../milomg-reactivity-benchmark/packages/core/src/util/perfLogging';
import { kairoBench } from '../../milomg-reactivity-benchmark/packages/core/src/benches/kairoBench';
import { sbench } from '../../milomg-reactivity-benchmark/packages/core/src/benches/sBench';
import { cellxbench } from '../../milomg-reactivity-benchmark/packages/core/src/benches/cellxBench';
import { dynamicBench } from '../../milomg-reactivity-benchmark/packages/core/src/benches/reactively/dynamicBench';

/**
 * Wrap our shared adapter in milomg's ReactiveFramework interface.
 * Mirrors the submodule's own alienSignals.ts adapter: one scope disposer
 * held between withBuild and cleanup.
 */
function toReactiveFramework(adapter: FrameworkAdapter): ReactiveFramework {
	let scope: (() => void) | null = null;
	return {
		name: adapter.name,
		signal: (initialValue) => adapter.signal(initialValue),
		computed: (fn) => adapter.computed(fn),
		effect: (fn) => {
			// milomg's interface types effect callbacks as `() => void`, but its
			// bench bodies are arrows that RETURN numbers (e.g. `() => x.read()`),
			// which alien v3.2+ would treat as cleanup functions and crash on.
			// Swallow the return value — uniformly for every framework.
			// The disposer is intentionally dropped: effects die with the scope.
			adapter.effect(() => {
				fn();
			});
		},
		withBatch: (fn) => {
			adapter.startBatch();
			try {
				fn();
			} finally {
				adapter.endBatch();
			}
		},
		withBuild: <T>(fn: () => T): T => {
			let out!: T;
			scope = adapter.effectScope(() => {
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
}

type SuiteRunner = (
	framework: ReactiveFramework,
	log: (result: PerfResult) => void,
) => Promise<void>;

const SUITES: Record<string, SuiteRunner> = {
	// kairo includes molBench as its final case.
	kairo: (fw, log) => kairoBench([{ framework: fw }], log),
	sbench: (fw, log) => sbench(fw, log),
	cellx: (fw, log) => cellxbench([{ framework: fw }], log),
	dynamic: (fw, log) => dynamicBench([{ framework: fw, testPullCounts: true }], log),
};

export const suiteNames = Object.keys(SUITES);

async function main(): Promise<void> {
	const frameworkName = process.env.FRAMEWORK ?? 'alien-v3';
	const requested = (process.env.SUITES ?? suiteNames.join(','))
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	for (const suite of requested) {
		if (!SUITES[suite]) {
			throw new Error(`Unknown suite "${suite}". Known suites: ${suiteNames.join(', ')}`);
		}
	}
	if (!globalThis.gc) {
		console.error('warning: gc() unavailable — run with --expose-gc');
	}

	const adapter = await loadAdapter(frameworkName);
	const framework = toReactiveFramework(adapter);

	for (const suite of requested) {
		console.error(`[${adapter.name}] running suite: ${suite}`);
		const log = (result: PerfResult) => {
			console.error(`  ${result.test}: ${result.time.toFixed(2)} ms`);
			console.log(`@@ROW ${JSON.stringify({ suite, ...result })}`);
		};
		await SUITES[suite](framework, log);
	}
}

await main();
