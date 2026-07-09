/**
 * Trace queries over the engine's causality log, shaped for "why did this
 * component re-render?" questions.
 */
import { attachTracer, debugId, type Readable, type Tracer, type TraceEvent } from 'signals-royale-fh2';

export interface TraceView {
	/** Formatted causal chain from the most recent delivery caused by this
	 * signal/computed back to its originating write or batch retirement. */
	whyLastDelivery(x: unknown): string[];
	events(): Array<{ id: number; kind: string; cause?: number }>;
	dropped(): number;
	stop(): void;
}

/** Starts tracing and returns a query view. */
export function traceView(options?: { ring?: number }): TraceView {
	const tracer: Tracer = attachTracer(options);
	return {
		whyLastDelivery(x: unknown): string[] {
			const tid = debugId(x as Readable<unknown>);
			const hit = tracer.last(
				(e: TraceEvent) => (e.kind === 'render' || e.kind === 'deliver') && e.data?.tid === tid,
			);
			if (hit === undefined) {
				return [];
			}
			return tracer.explain(hit.id);
		},
		events: () =>
			tracer.events().map((e) => (e.cause === undefined ? { id: e.id, kind: e.kind } : { id: e.id, kind: e.kind, cause: e.cause })),
		dropped: () => tracer.dropped(),
		stop: () => tracer.stop(),
	};
}
