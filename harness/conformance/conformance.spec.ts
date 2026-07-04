/**
 * Conformance runner: runs the full reactive-framework-test-suite against
 * the adapter named by env FRAMEWORK (default: alien-v3).
 *
 *   FRAMEWORK=arrayd pnpm -C harness conformance
 *
 * Wiring copied from upstream-alien-signals/tests/conformance.spec.ts.
 */
import { describe, expect, test } from 'vitest';
import {
	testSuite,
	SkipTest,
	setExpect,
	type ReactiveFramework,
} from 'reactive-framework-test-suite';
import { loadAdapter } from '../adapters/index';

const frameworkName = process.env.FRAMEWORK ?? 'alien-v3';
const adapter = await loadAdapter(frameworkName);

const framework: ReactiveFramework = {
	name: adapter.name,
	signal(initialValue) {
		return adapter.signal(initialValue);
	},
	computed(fn) {
		return adapter.computed(fn);
	},
	effect(fn) {
		return adapter.effect(fn);
	},
	run(fn) {
		adapter.effectScope(fn)();
	},
	batch(fn) {
		adapter.startBatch();
		try {
			fn();
		} finally {
			adapter.endBatch();
		}
	},
	untracked: adapter.untracked,
};

setExpect(expect);

for (const { section, cases } of testSuite) {
	describe(`${frameworkName} :: ${section}`, () => {
		for (const [name, fn] of Object.entries(cases)) {
			test(name, () => {
				try {
					framework.run(() => fn(framework));
				} catch (e) {
					if (e instanceof SkipTest) return;
					throw e;
				}
			});
		}
	});
}
