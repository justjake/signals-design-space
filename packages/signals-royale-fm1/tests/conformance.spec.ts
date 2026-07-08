/**
 * Full reactive-framework-test-suite conformance run (179 cases).
 * Wiring shape follows harness/conformance/conformance.spec.ts.
 */
import { describe, expect, test } from 'vitest';
import {
	testSuite,
	SkipTest,
	setExpect,
	type ReactiveFramework,
} from 'reactive-framework-test-suite';
import * as fm1 from '../src/index';

const framework: ReactiveFramework = {
	name: 'signals-royale-fm1',
	signal<T>(initialValue: T) {
		const a = fm1.atom(initialValue);
		return { read: () => a.get(), write: (v: T) => a.set(v) };
	},
	computed<T>(fn: () => T) {
		const c = fm1.computed(fn);
		return { read: () => c.get() };
	},
	effect(fn) {
		return fm1.effect(fn);
	},
	run(fn) {
		fm1.effectScope(fn)();
	},
	batch(fn) {
		fm1.batch(fn);
	},
	untracked: fm1.untracked,
};

setExpect(expect);

for (const { section, cases } of testSuite) {
	describe(`fm1 :: ${section}`, () => {
		for (const [name, fn] of Object.entries(cases)) {
			test(name, () => {
				try {
					framework.run!(() => fn(framework));
				} catch (e) {
					if (e instanceof SkipTest) return;
					throw e;
				}
			});
		}
	});
}
