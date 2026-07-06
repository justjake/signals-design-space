/**
 * Adapter for packages/cosignals-alt-b (variant B of the cosignal-arena spec:
 * quiescence write gate, documented loose contract). Routes through the
 * module-singleton engine's public API — Atom/Computed option-object
 * constructors with `.state` getters and `.set` — so conformance and benches
 * measure the surface applications use, error/suspense boxing included.
 */
import {
	__resetEngineForTests,
	Atom,
	Computed,
	effect,
	effectScope,
	endBatch,
	startBatch,
	untracked,
} from 'cosignals-alt-b';
import type { FrameworkAdapter } from './types';

// The engine's typed-array planes regrow only at operation boundaries
// (enterDepth === 0). A single effectScope that allocates tens of thousands
// of nodes+links (bench "create" shape: 30k records in one operation)
// exhausts the default 8192-record main plane mid-operation, which throws by
// design. Pre-size the module-singleton engine once at load, before any node
// exists (same reset hook the package's own perf suite uses). 2^18 records
// = an 8 MiB Int32Array main plane.
__resetEngineForTests({ initialRecords: 1 << 18 });

const adapter: FrameworkAdapter = {
	name: 'cosignals-alt-b',
	signal(initialValue) {
		const a = new Atom({ state: initialValue });
		return {
			read: () => a.state,
			write: (v) => a.set(v),
		};
	},
	computed(fn) {
		const c = new Computed({ fn });
		return { read: () => c.state };
	},
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
};

export default adapter;
