/** ReactiveFramework adapter for the milomg js-reactivity-benchmark. */
import {
	batch,
	createComputed,
	effect,
	effectScope,
	createAtom,
	type Atom,
	type Computed,
	type Signal,
} from '../src/index.ts'
import { installState } from '../src/ssr.ts'

export interface ReactiveFramework<S = unknown> {
	name: string
	createSignal(initialValue: unknown): S
	readSignal(signal: S): unknown
	writeSignal(signal: S, value: unknown): void
	createComputed(fn: () => unknown): S
	readComputed(cell: S): unknown
	effect(fn: () => void): void
	withBatch(fn: () => void): void
	withBuild<T>(fn: () => T): T
	cleanup(): void
}

type Cell = Signal<unknown>

let disposeScope: (() => void) | null = null

const NEVER_EQUAL = (): boolean => false
const NOOP_HANDLER = (): void => {}

const framework: ReactiveFramework<Cell> = {
	name: 'Royale FX2',
	createSignal(initialValue) {
		const s = createAtom(initialValue)
		if (typeof initialValue === 'function') {
			// The benchmark stores plain values; opt out of lazy-initializer
			// treatment for function-valued ones.
			installState(s, initialValue)
		}
		return s
	},
	readSignal(s) {
		return (s as Atom<unknown>).get()
	},
	writeSignal(s, value) {
		;(s as Atom<unknown>).set(value)
	},
	createComputed(fn) {
		return createComputed(fn)
	},
	readComputed(cell) {
		return (cell as Computed<unknown>).get()
	},
	effect(fn) {
		// The benchmark's effect is a single tracked body (it reads and
		// counts, never writes signals): run it as the compute, deliver to a
		// no-op handler on every re-run.
		effect(fn, NOOP_HANDLER, { equals: NEVER_EQUAL })
	},
	withBatch(fn) {
		batch(fn)
	},
	withBuild<T>(fn: () => T): T {
		let out!: T
		// Effects created during the build attach to this scope; cleanup()
		// disposes them all, so the benchmark never leaks graphs across runs.
		disposeScope = effectScope(() => {
			out = fn()
		})
		return out
	},
	cleanup() {
		disposeScope?.()
		disposeScope = null
	},
}

export default framework
export { createAtom, framework as royaleFx2Framework }
