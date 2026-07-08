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
 * static imports of every implementation — initializing all three engines
 * on every page. Keeping isolation therefore forces a dynamic import
 * somewhere, and doing it here keeps it in exactly one place: each
 * implementation becomes its own code-split chunk, only the selected chunk
 * ever loads (dev and production alike), and no import-evaluation-order
 * contract exists to silently break.
 *
 * Every module importing this specifier waits on the top-level await, so by
 * the time any app code runs, the page's implementation is bound.
 */
import type { ConcurrentSignalsShim } from './interface';

// Typed loaders: each import() namespace is checked against the shim
// interface at this map, so a shim missing part of the surface fails
// typecheck here rather than at a use site.
const implByPathSegment: Record<string, (() => Promise<ConcurrentSignalsShim>) | undefined> = {
	'': () => import('./cosignals'),
	'alt-a': () => import('./alt-a'),
	'alt-b': () => import('./alt-b'),
};

// First non-empty segment: '/' → '', '/alt-a/' and '/alt-a/index.html' → 'alt-a'.
// Assumes the app is served at base '/', like vite dev and vite preview here.
const segment = window.location.pathname.split('/').find((part) => part !== '') ?? '';
const load = implByPathSegment[segment];
if (load === undefined) {
	throw new Error(`react-signals-playground: no implementation mapped for path segment "/${segment}"`);
}

const impl: ConcurrentSignalsShim = await load();

export const name = impl.name;
export const register = impl.register;
export const createAtom = impl.createAtom;
export const createComputed = impl.createComputed;
export const useSignal = impl.useSignal;
export const useComputed = impl.useComputed;
export const useSignalEffect = impl.useSignalEffect;
export const startSignalTransition = impl.startSignalTransition;

export type { ConcurrentSignalsShim, ReadableSignal, WritableSignal } from './interface';
