/**
 * Conformance smoke for the NF2 spike: the 179-case
 * reactive-framework-test-suite against the world-tagged prototype with ZERO
 * worlds open — sync semantics must be unchanged. Mirrors
 * harness/conformance/conformance.spec.ts (FRAMEWORK=cosignal wiring).
 */
import { describe, expect, test } from 'vitest';
import { testSuite, SkipTest, setExpect, type ReactiveFramework } from 'reactive-framework-test-suite';
import { Atom, Computed, effect, effectScope, startBatch, endBatch, untracked, __worldLiveCount } from '../cosignal/src/index.js';

const framework: ReactiveFramework = {
	name: 'cosignal-world-spike',
	signal(initialValue) {
		const a = new Atom(initialValue);
		return { read: () => a.state, write: (v) => a.set(v) };
	},
	computed(fn) {
		const c = new Computed(fn);
		return { read: () => c.state };
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
	describe(`cosignal-world-spike :: ${section}`, () => {
		for (const [name, fn] of Object.entries(cases)) {
			test(name, () => {
				expect(__worldLiveCount()).toBe(0); // the zero-world premise
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
