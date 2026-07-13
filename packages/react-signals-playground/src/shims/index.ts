/**
 * '#concurrent-signals-shim' — the selector this package.json "imports"
 * entry resolves to. One implementation per page, chosen by the first path
 * segment, loaded with a top-level-await dynamic import.
 *
 * Why runtime selection instead of a per-entry "select before the shim
 * initializes" side-effect module: these engines are module singletons that
 * claim exclusive React protocol registrations (exactly one batch-id
 * allocator per page), so the implementations that were NOT selected must
 * never initialize. A selector that re-exports synchronously would need
 * static imports of every implementation — initializing every engine
 * on every page. Keeping isolation therefore forces a dynamic import
 * somewhere, and doing it here keeps it in exactly one place: each
 * implementation becomes its own code-split chunk, only the selected chunk
 * ever loads (dev and production alike), and no import-evaluation-order
 * contract exists to silently break.
 *
 * Every module importing this specifier waits on the top-level await, so by
 * the time any app code runs, the page's implementation is bound.
 */
import type { ConcurrentSignalsShim } from './interface'
import { implementations } from './implementations'

// First non-empty segment: '/' → '', '/alt-a/' and '/alt-a/index.html' → 'alt-a'.
// Assumes the app is served at base '/', like vite dev and vite preview here.
const segment = window.location.pathname.split('/').find((part) => part !== '') ?? ''
const entry = implementations.find((impl) => impl.segment === segment)
if (entry === undefined) {
	throw new Error(
		`react-signals-playground: no implementation mapped for path segment "/${segment}"`,
	)
}

const impl: ConcurrentSignalsShim = await entry.load()

export const name = impl.name
export const register = impl.register
export const createRoot = impl.createRoot
export const createAtom = impl.createAtom
export const createComputed = impl.createComputed
export const useSignal = impl.useSignal
export const useComputed = impl.useComputed
export const useSignalEffect = impl.useSignalEffect
export const startSignalTransition = impl.startSignalTransition
export const transitionHoldStyle = impl.transitionHoldStyle

// The implementation table rides along for the app's tab bar: exporting it
// here keeps components on the single '#concurrent-signals-shim' specifier.
// Re-exporting the table triggers no implementation loads — rows hold
// dynamic-import thunks, and only the selected one was invoked above.
export { implementationHref, implementations } from './implementations'
export type { Implementation } from './implementations'
export type {
	ConcurrentSignalsShim,
	ReadableSignal,
	TransitionHoldStyle,
	WritableSignal,
} from './interface'
