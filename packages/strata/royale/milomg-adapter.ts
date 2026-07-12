import { type Atom, type Computed, atom, batch, computed, effect, effectScope } from '../src/index'

type Cell = Atom<unknown> | Computed<unknown>

let disposeScope: (() => void) | undefined

export default {
	name: 'Strata',
	createSignal(initialValue: unknown): Cell {
		return atom(initialValue)
	},
	readSignal(signal: Cell): unknown {
		return signal.state
	},
	writeSignal(signal: Cell, value: unknown): void {
		;(signal as Atom<unknown>).set(value)
	},
	createComputed(fn: () => unknown): Cell {
		return computed(fn)
	},
	readComputed(cell: Cell): unknown {
		return cell.state
	},
	effect(fn: () => void): void {
		effect(fn)
	},
	withBatch(fn: () => void): void {
		batch(fn)
	},
	withBuild<T>(fn: () => T): T {
		let result!: T
		disposeScope = effectScope(() => {
			result = fn()
		})
		return result
	},
	cleanup(): void {
		disposeScope?.()
		disposeScope = undefined
	},
}
