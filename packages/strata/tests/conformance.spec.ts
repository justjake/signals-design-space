import { describe, expect, test } from 'vitest';
import {
	testSuite,
	SkipTest,
	setExpect,
	type ReactiveFramework,
} from 'reactive-framework-test-suite';
import adapter from '../royale/harness-adapter';

const framework: ReactiveFramework = {
	name: adapter.name,
	signal: (initialValue) => adapter.signal(initialValue),
	computed: (fn) => adapter.computed(fn),
	effect: (fn) => adapter.effect(fn),
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
	describe(`strata-signals :: ${section}`, () => {
		for (const [name, fn] of Object.entries(cases)) {
			test(name, () => {
				try {
					framework.run(() => fn(framework));
				} catch (error) {
					if (error instanceof SkipTest) return;
					throw error;
				}
			});
		}
	});
}
