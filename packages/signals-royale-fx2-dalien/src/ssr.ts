import type { Atom } from './index.ts'
import { type CellNode, assertSignalWriteAllowed, peekCell } from './graph.ts'

/** Atoms under app-supplied keys: positional (array) or named (record). */
type AtomMap = Record<string, Atom<any>> | Atom<any>[]

/** Serialize base atom state under app-supplied keys. */
export function serializeAtomState(
	atoms: AtomMap,
	replacer?: (key: string, value: unknown) => unknown,
): string {
	const out: Record<string, unknown> = {}
	if (Array.isArray(atoms)) {
		for (let i = 0; i < atoms.length; i++) {
			out[i] = peekCell(atoms[i] as unknown as CellNode<unknown>)
		}
	} else {
		for (const key in atoms) {
			if (Object.prototype.hasOwnProperty.call(atoms, key)) {
				out[key] = peekCell(atoms[key] as unknown as CellNode<unknown>)
			}
		}
	}
	return JSON.stringify(out, replacer)
}

/**
 * Install a value without running lazy initializers and without counting
 * as a write: no propagation, no equality check, no effects.
 */
export function installState<T>(atom: Atom<T>, value: T): void {
	assertSignalWriteAllowed()
	const node = atom as unknown as CellNode<T>
	node.initializer = undefined
	node.value = value
}

/**
 * Restore atom state previously produced by {@link serializeAtomState}.
 *
 * Arrays use their numeric positions and records use their own keys. Missing
 * keys are ignored. Restoration uses {@link installState}, so it does not run
 * lazy initializers or notify subscribers.
 */
export function initializeAtomState(
	json: string,
	atoms: AtomMap,
	reviver?: (key: string, value: unknown) => unknown,
): void {
	const data = JSON.parse(json, reviver) as Record<string, unknown>
	if (Array.isArray(atoms)) {
		for (let i = 0; i < atoms.length; i++) {
			if (Object.prototype.hasOwnProperty.call(data, i)) {
				installState(atoms[i], data[i])
			}
		}
	} else {
		for (const key in atoms) {
			if (
				Object.prototype.hasOwnProperty.call(atoms, key) &&
				Object.prototype.hasOwnProperty.call(data, key)
			) {
				installState(atoms[key], data[key])
			}
		}
	}
}
