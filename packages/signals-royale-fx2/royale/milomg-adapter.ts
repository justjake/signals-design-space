/** ReactiveFramework adapter for the milomg js-reactivity-benchmark. */
import {
	Computed,
	batch,
	computed,
	effect,
	effectScope,
	installState,
	signal,
	type Signal,
} from '../src/index.ts'

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

type Cell = Signal<unknown> | Computed<unknown>

let disposeScope: (() => void) | null = null

const framework: ReactiveFramework<Cell> = {
	name: 'Royale FX2',
	createSignal(initialValue) {
		const s = signal(initialValue)
		if (typeof initialValue === 'function') {
			// The benchmark stores plain values; opt out of lazy-initializer
			// treatment for function-valued ones.
			installState(s, initialValue)
		}
		return s
	},
	readSignal(s) {
		return (s as Signal<unknown>).get()
	},
	writeSignal(s, value) {
		;(s as Signal<unknown>).set(value)
	},
	createComputed(fn) {
		return computed(fn)
	},
	readComputed(cell) {
		return (cell as Computed<unknown>).get()
	},
	effect(fn) {
		effect(fn)
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
export { framework as royaleFx2Framework, signal }
