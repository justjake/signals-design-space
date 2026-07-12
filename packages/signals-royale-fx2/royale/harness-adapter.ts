/** FrameworkAdapter for the shared conformance/bench harness. */
import {
	createComputed,
	effect,
	effectScope,
	endBatch,
	installState,
	createAtom,
	startBatch,
	type Computed,
	untracked,
} from '../src/index.ts'

export interface AdapterSignal<T> {
	read(): T
	write(value: T): void
}
export interface AdapterComputed<T> {
	read(): T
}
export interface FrameworkAdapter {
	name: string
	signal<T>(initialValue: T): AdapterSignal<T>
	computed<T>(fn: () => T): AdapterComputed<T>
	effect(fn: () => void | (() => void)): () => void
	effectScope(fn: () => void): () => void
	startBatch(): void
	endBatch(): void
	untracked<T>(fn: () => T): T
}

const adapter: FrameworkAdapter = {
	name: 'signals-royale-fx2',
	signal<T>(initialValue: T): AdapterSignal<T> {
		// The engine treats function-valued initials as lazy initializers; the
		// harness stores plain values, including functions, so opt out here.
		const s = createAtom(initialValue)
		if (typeof initialValue === 'function') {
			installState(s, initialValue)
		}
		return {
			read: () => s.get(),
			write: (value: T) => s.set(value),
		}
	},
	computed<T>(fn: () => T): AdapterComputed<T> {
		const c: Computed<T> = createComputed(fn)
		return { read: () => c.get() }
	},
	effect,
	effectScope,
	startBatch,
	endBatch,
	untracked,
}

export default adapter
