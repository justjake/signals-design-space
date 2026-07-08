/**
 * cosignals-alt-a — variant A (monotonic write-gate activation) of the
 * react-concurrent-signals-arena-alt-a spec.
 *
 * The default export surface is the §4 API bound to a module-singleton
 * engine (the browser shape: one interactive document, one engine).
 * `createServerEngine()` (§13.8) returns an isolated engine + API per
 * request; `createCosignalEngine` is the low-level factory.
 */
export {
	createCosignalEngine,
	type CosignalEngine,
	type AtomHandle,
	type ReducerAtomHandle,
	type ComputedHandle,
	type SignalHandle,
	type WatcherHandle,
	type BroadcastEvent,
	type WorldSelector,
	type EngineOptions,
	type Equality,
} from './engine';
export {
	createForkDouble,
	type ForkDouble,
	type ForkAdapter,
	type BatchScript,
	type PassScript,
	type Container,
	type ExternalRuntimeListener,
} from './fork-double';
export {
	createTracer,
	TraceKind,
	TRACE_KIND_NAMES,
	type Tracer,
	type TracerMode,
	type TraceEvent,
} from './tracing';
export {
	createAPI,
	isErrorBox,
	isSuspendedBox,
	type CosignalAPI,
	type AtomCtx,
	type AtomOptions,
	type ReducerAtomOptions,
	type ComputedCtx,
	type ComputedOptions,
	type ErrorBox,
	type SuspendedBox,
} from './api';

import { createCosignalEngine as _create } from './engine';
import { createAPI as _createAPI, type CosignalAPI as _API } from './api';

/** The module-singleton engine + API (browser shape). */
export const defaultEngine = _create();
const defaultAPI = _createAPI(defaultEngine);
/** The full default-engine API bundle (what registerAltAReact consumes). */
export const defaultApi = defaultAPI;
export const Atom = defaultAPI.Atom;
export const ReducerAtom = defaultAPI.ReducerAtom;
export const Computed = defaultAPI.Computed;
export const effect = defaultAPI.effect;
export const effectScope = defaultAPI.effectScope;
export const batch = defaultAPI.batch;
/** Low-level batch surface (adapter/bindings plumbing; prefer batch()). */
export const startBatch = defaultEngine.startBatch;
export const endBatch = defaultEngine.endBatch;
export const untracked = defaultAPI.untracked;
export const configure = defaultAPI.configure;
/** The READ FAMILY (alt-family visibility rule, SPEC-RESOLUTIONS):
 * `.state` = real (W0), latest() = intent (Wn incl. drafts),
 * committed() = on screen, isPending() = loading. */
export const latest = defaultAPI.latest;
export const committed = defaultAPI.committed;
export const isPending = defaultAPI.isPending;
export const refresh = defaultAPI.refresh;

/** §13.8: one isolated engine per server request. */
export function createServerEngine(options?: import('./engine').EngineOptions): _API {
	return _createAPI(_create(options));
}
