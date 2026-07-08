import 'react';

declare module 'react' {
	export interface SignalRuntimeListener {
		onRenderPassStart?(container: object, lanes: number): void;
		onRenderPassEnd?(container: object): void;
		onCommit?(container: object, committed: number, remaining: number): void;
		onBeforeMutation?(container: Element): void;
		onAfterMutation?(container: Element): void;
	}
	export function unstable_subscribeToExternalRuntime(listener: SignalRuntimeListener): () => void;
	export function unstable_getRenderContext(): null | { container: object; renderLanes: number };
	export function unstable_getCurrentUpdateLane(): number;
	export function unstable_isTransitionLane(lane: number): boolean;
	export function unstable_lanesInclude(lanes: number, lane: number): boolean;
}
