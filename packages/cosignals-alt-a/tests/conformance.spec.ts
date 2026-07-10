/**
 * §17.1 — the reactive-framework conformance suite (the bar alien-signals
 * itself sets), run against this engine's core adapter in four episodes:
 *
 *   1. DIRECT mode (the donor-kernel contract),
 *   2. DIRECT with growth stress (initialRecords: 2 — every case crosses
 *      plane doublings),
 *   3. §17.5(a): LOGGED, every top-level write in a synthetic deferred batch
 *      that immediately retires and absorbs,
 *   4. §17.5(b): LOGGED, the whole suite running while an unrelated live
 *      deferred batch holds a log on an unrelated atom.
 *
 * Episodes 3–4 are the invisibility tests: the overlay must be semantically
 * invisible when it contains everything and when it contains nothing
 * relevant.
 */
import { describe, expect, test } from 'vitest'
import {
	SkipTest,
	setExpect,
	testSuite,
	type ReactiveFramework,
} from 'reactive-framework-test-suite'
import { createCosignalEngine, type CosignalEngine, type EngineOptions } from '../src/engine'
import { createForkDouble } from '../src/fork-double'

setExpect(expect)

type Episode = {
	name: string
	make(): { engine: CosignalEngine; write: (doWrite: () => void) => void }
}

function directEpisode(name: string, options?: EngineOptions): Episode {
	return {
		name,
		make() {
			const engine = createCosignalEngine(options)
			return { engine, write: (doWrite) => doWrite() }
		},
	}
}

const episodes: Episode[] = [
	directEpisode('direct'),
	directEpisode('direct growth-stress', {
		initialRecords: 2,
		initialLogRecords: 1,
		initialMemoRecords: 1,
	}),
	{
		name: 'logged synthetic-retire (17.5a)',
		make() {
			const engine = createCosignalEngine()
			const fork = createForkDouble()
			engine.attachFork(fork)
			fork.registerRoot('root')
			// Top-level writes ride a fresh deferred batch retired immediately;
			// nested writes (effect cascades inside the outer write's stack)
			// go through as plain urgent writes.
			let writing = false
			return {
				engine,
				write(doWrite) {
					if (writing) {
						doWrite()
						return
					}
					writing = true
					try {
						const b = fork.openBatch('deferred')
						b.run(doWrite)
						b.retire(true)
					} finally {
						writing = false
					}
				},
			}
		},
	},
	{
		name: 'logged unrelated-live-batch (17.5b)',
		make() {
			const engine = createCosignalEngine()
			const fork = createForkDouble()
			engine.attachFork(fork)
			fork.registerRoot('root')
			const unrelated = engine.atom(0)
			const t = fork.openBatch('deferred')
			t.run(() => unrelated.set(1)) // a live log + marks elsewhere, forever
			return { engine, write: (doWrite) => doWrite() }
		},
	},
]

for (const episode of episodes) {
	describe(`§17.1 conformance :: ${episode.name}`, () => {
		for (const { section, cases } of testSuite) {
			describe(section, () => {
				for (const [name, fn] of Object.entries(cases)) {
					test(name, () => {
						const { engine, write } = episode.make()
						const framework: ReactiveFramework = {
							name: `cosignals-alt-a ${episode.name}`,
							signal<T>(initialValue: T) {
								const a = engine.atom<T>(initialValue)
								return {
									read: () => a.state,
									write: (v: T) => write(() => a.set(v)),
								}
							},
							computed<T>(fnc: () => T) {
								const c = engine.computed<T>(fnc)
								return { read: () => c.state }
							},
							effect: (fne) => engine.effect(fne),
							run(fnr) {
								engine.effectScope(fnr)()
							},
							batch: (fnb) => {
								engine.batch(fnb)
							},
							untracked: (fnu) => engine.untracked(fnu),
						}
						try {
							framework.run(() => fn(framework))
						} catch (e) {
							if (e instanceof SkipTest) return
							throw e
						}
					})
				}
			})
		}
	})
}
