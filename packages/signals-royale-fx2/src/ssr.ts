import type { Atom } from './index.ts'
import { type AtomNode, assertSignalWriteAllowed, peekAtom } from './graph.ts'

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
			out[i] = peekAtom(atoms[i] as unknown as AtomNode<unknown>)
		}
	} else {
		for (const key in atoms) {
			if (Object.prototype.hasOwnProperty.call(atoms, key)) {
				out[key] = peekAtom(atoms[key] as unknown as AtomNode<unknown>)
			}
		}
	}
	return JSON.stringify(out, replacer)
}

/** Install a value without running lazy initializers and without counting
 * as a write: no propagation, no equality check, no effects. */
export function installState<T>(atom: Atom<T>, value: T): void {
	assertSignalWriteAllowed()
	const node = atom as unknown as AtomNode<T>
	node.initializer = undefined
	node.value = value
}

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
