/**
 * The causality debug surface: start a trace, ask why a component's latest
 * delivery happened, read the raw event stream, stop.
 */
import { Tracer, formatEvent, type Readable, type TraceEvent } from 'signals-royale-fm1';

export interface RoyaleTraceView {
	/** Formatted causal chain from the most recent component delivery caused
	 * by this signal/computed, back to its originating write or retirement. */
	whyLastDelivery(x: unknown): string[];
	events(): Array<{ id: number; kind: string; cause?: number }>;
	stop(): void;
}

/** Start tracing (bounded ring by default; overflow is counted, never
 * silent). */
export function trace(opts?: { capacity?: number }): RoyaleTraceView {
	const tracer = new Tracer({ capacity: opts?.capacity ?? 10_000 }).attach();
	return {
		whyLastDelivery(x: unknown): string[] {
			const label = (x as Readable<unknown>).label;
			return tracer.explainLast(
				(e: TraceEvent) =>
					e.kind === 'deliver' && (label === undefined || e.detail?.label === label),
			);
		},
		events() {
			return tracer.events.map((e) => ({ id: e.id, kind: e.kind, cause: e.cause }));
		},
		stop() {
			tracer.detach();
		},
	};
}

export { formatEvent };
