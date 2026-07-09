/**
 * Causality queries over the engine tracer, phrased for React users:
 * "why did this component just re-render?"
 */
import { startTrace, type Tracer, type TraceEvent } from 'signals-royale-fm2';

export interface TraceView {
	/** Formatted causal chain from the most recent component delivery caused
	 * by `x` back to its originating write or batch retirement. */
	whyLastDelivery(x: unknown): string[];
	events(): Array<{ id: number; kind: string; cause?: number }>;
	stop(): void;
}

export function whyLastDelivery(t: Tracer, x: unknown): string[] {
	return t.why((e: TraceEvent) => e.kind === 'deliver' && e.data?.node === x);
}

/** Start tracing; the view exposes deliveries, events, and detach. */
export function traceView(capacity = 10_000): TraceView {
	const t = startTrace(capacity);
	return {
		whyLastDelivery: (x) => whyLastDelivery(t, x),
		events: () =>
			t.events().map((e) => ({
				id: e.id,
				kind: e.kind,
				cause: e.cause === 0 ? undefined : e.cause,
			})),
		stop: () => t.stop(),
	};
}
