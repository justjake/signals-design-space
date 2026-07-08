/**
 * Runs the full reactive-framework-test-suite (179 cases) against the engine's
 * canonical semantics. Wiring shape follows the repo's conformance harness.
 */
import { describe, expect, test } from 'vitest';
import {
	testSuite,
	SkipTest,
	setExpect,
	type ReactiveFramework,
} from 'reactive-framework-test-suite';
import { atom, computed, effect, effectScope, startBatch, endBatch, untracked } from '../src/index';

const framework: ReactiveFramework = {
	name: 'signals-royale-fh1',
	signal(initialValue) {
		const a = atom(initialValue);
		return {
			read: () => a.get(),
			write: (v) => a.set(v),
		};
	},
	computed(fn) {
		const c = computed(fn);
		return { read: () => c.get() };
	},
	effect(fn) {
		return effect(fn);
	},
	run(fn) {
		effectScope(fn)();
	},
	batch(fn) {
		startBatch();
		try {
			fn();
		} finally {
			endBatch();
		}
	},
	untracked,
};

setExpect(expect);

for (const { section, cases } of testSuite) {
	describe(`signals-royale-fh1 :: ${section}`, () => {
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
