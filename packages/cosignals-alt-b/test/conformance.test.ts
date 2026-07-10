// §17.1 — the reactive-framework conformance suite (179 cases, the bar
// alien-signals itself sets) wired into package CI, in four episodes:
//
//   1. DIRECT mode (the donor-kernel contract),
//   2. DIRECT with growth stress (tiny planes: every case crosses closure
//      rebuilds),
//   3. §17.5(a) invisibility: LOGGED, every top-level write riding a fresh
//      synthetic deferred batch that immediately retires and absorbs,
//   4. §17.5(b) invisibility: LOGGED, the whole suite running while an
//      unrelated live deferred batch holds a log on an unrelated atom.
//
// Episodes 3-4 are the §17.5 invisibility tests: the overlay must be
// semantically invisible both when it contains everything and when it
// contains nothing relevant. Includes the three settle-back cases
// (#123/#132/#147) this suite caught before they were pinned (see
// pendingAtomValue in src/engine.ts).
import { describe, expect, test } from 'vitest'
import {
	SkipTest,
	setExpect,
	testSuite,
	type ReactiveFramework,
} from 'reactive-framework-test-suite'
import {
	Atom,
	Computed,
	ForkDouble,
	__resetEngineForTests,
	attachFork,
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
} from '../src/index'

setExpect(expect)

type Episode = {
	name: string
	/** prepare the module-singleton engine; returns the top-level write wrapper */
	make(): (doWrite: () => void) => void
}

const episodes: Episode[] = [
	{
		name: 'direct',
		make() {
			__resetEngineForTests()
			return (doWrite) => doWrite()
		},
	},
	{
		name: 'direct growth-stress',
		make() {
			__resetEngineForTests({ initialRecords: 2, initialLogRecords: 1, initialMemoRecords: 1 })
			return (doWrite) => doWrite()
		},
	},
	{
		name: 'logged synthetic-retire (17.5a)',
		make() {
			__resetEngineForTests()
			const fork = new ForkDouble()
			attachFork(fork)
			// Top-level writes ride a fresh deferred batch retired immediately;
			// nested writes (effect cascades inside the outer write's stack)
			// go through as plain writes.
			let writing = false
			return (doWrite) => {
				if (writing) {
					doWrite()
					return
				}
				writing = true
				try {
					const t = fork.openBatch(true)
					try {
						fork.inBatch(t, doWrite)
					} finally {
						// Retire even when the write throws (batch-throw cases
						// #69/#154): React always retires its batches.
						fork.retireBatch(t, true)
					}
				} finally {
					writing = false
				}
			}
		},
	},
	{
		name: 'logged unrelated-live-batch (17.5b)',
		make() {
			__resetEngineForTests()
			const fork = new ForkDouble()
			attachFork(fork)
			const unrelated = new Atom({ state: 0 })
			const t = fork.openBatch(true)
			fork.inBatch(t, () => unrelated.set(1)) // a live log + marks, forever
			return (doWrite) => doWrite()
		},
	},
]

for (const episode of episodes) {
	describe(`§17.1 conformance :: ${episode.name}`, () => {
		for (const { section, cases } of testSuite) {
			describe(section, () => {
				for (const [name, fn] of Object.entries(cases)) {
					test(name, () => {
						const write = episode.make()
						const framework: ReactiveFramework = {
							name: `cosignals-alt-b ${episode.name}`,
							signal<T>(initialValue: T) {
								const a = new Atom({ state: initialValue })
								return {
									read: () => a.state,
									write: (v: T) => write(() => a.set(v)),
								}
							},
							computed<T>(fnc: () => T) {
								const c = new Computed({ fn: fnc })
								return { read: () => c.state }
							},
							effect,
							run(fnr) {
								effectScope(fnr)()
							},
							batch(fnb) {
								write(() => {
									startBatch()
									try {
										fnb()
									} finally {
										endBatch()
									}
								})
							},
							untracked,
						}
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
	})
}
