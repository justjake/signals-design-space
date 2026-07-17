/**
 * Conformance runner: runs the full reactive-framework-test-suite against
 * the adapter named by env FRAMEWORK (default: alien-v3).
 *
 *   FRAMEWORK=arrayd pnpm -C harness conformance
 *
 * Wiring copied from upstream-alien-signals/tests/conformance.spec.ts.
 */
import { describe, expect, test } from 'vitest'
import {
	testSuite,
	SkipTest,
	setExpect,
	type ReactiveFramework,
} from 'reactive-framework-test-suite'
import { loadAdapter } from '../adapters/index'

const frameworkName = process.env.FRAMEWORK ?? 'alien-v3'
const adapter = await loadAdapter(frameworkName)

const framework: ReactiveFramework = {
	name: adapter.name,
	signal(initialValue) {
		return adapter.signal(initialValue)
	},
	computed(fn) {
		return adapter.computed(fn)
	},
	effect(fn) {
		return adapter.effect(fn)
	},
	run(fn) {
		adapter.effectScope(fn)()
	},
	batch(fn) {
		adapter.startBatch()
		try {
			fn()
		} finally {
			adapter.endBatch()
		}
	},
	untracked: adapter.untracked,
}

setExpect(expect)

for (const { section, cases } of testSuite) {
	describe(`${frameworkName} :: ${section}`, () => {
		for (const [name, fn] of Object.entries(cases)) {
			// reactive-framework-test-suite 0.0.2 treats avoiding all work
			// after a batch net-revert as semantics. Cosignals intentionally promises
			// only final-value atomicity; its replacement case below checks that
			// contract without constraining conservative validation/effect work.
			if (
				frameworkName === 'cosignals' &&
				(name === "#123 repeated no-op batches don't re-trigger effects" ||
					name === '#132 batch: computed not recomputed if dep reverts' ||
					name === '#147 computed not recomputed in batch if dep reverts')
			) {
				continue
			}
			// Cosignals's effect is a pure tracked compute plus an untracked handler;
			// the suite's single-body autorun runs through an adapter shim whose
			// body is the compute. These five cases pin interleavings of that
			// single body (body-vs-cleanup order, run counts during validation,
			// ownership of effects created mid-body) that the shim cannot
			// reproduce. The package suite pins the same concerns against the
			// real two-function contract (tests/conformance.spec.ts).
			if (
				frameworkName === 'cosignals' &&
				(name === '#38 effect cleanup fn called before each re-run' ||
					name === '#89 effect cleanup reset when effect throws' ||
					name === '#201 computed-triggered disposal: effect skipped and no subscription leak' ||
					name === '#209 three-level nested effect: cascading disposal' ||
					name === '#210 multiple inner effects all cleaned when outer re-runs')
			) {
				continue
			}
			test(name, () => {
				try {
					framework.run(() => fn(framework))
				} catch (e) {
					if (e instanceof SkipTest) {
						return
					}
					throw e
				}
			})
		}
	})
}

if (frameworkName === 'cosignals') {
	describe('cosignals :: batch net-revert semantics', () => {
		test('#123/#132/#147 expose only final values', () => {
			framework.run(() => {
				const atom = framework.signal(0)
				const lazy = framework.computed(() => atom.read() * 2)
				let observed = -1
				framework.effect(() => {
					observed = lazy.read()
				})

				framework.batch!(() => {
					atom.write(5)
					atom.write(0)
				})

				expect(atom.read()).toBe(0)
				expect(lazy.read()).toBe(0)
				expect(observed).toBe(0)
			})
		})
	})
}
