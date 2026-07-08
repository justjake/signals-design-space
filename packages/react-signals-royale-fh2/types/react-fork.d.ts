/**
 * Ambient declarations for the external-signals seam these bindings
 * consume. The patched React build exposes `unstable_externalSignals` from
 * react-dom/client; @types/react-dom covers only the stock surface, so the
 * seam is declared here. Lanes cross the seam as opaque numbers.
 */
declare module 'react-dom/client' {
	/** An opaque React scheduling lane bitmask. */
	export type SignalsLanes = number;

	export interface SignalsFiberRoot {
		/** The DOM container this root renders into. */
		containerInfo: Element;
	}

	export type SignalsCommitPhase = 'mutation-start' | 'mutation-stop' | 'committed';

	export interface ExternalSignalsRuntime {
		onPassStarted(root: SignalsFiberRoot, lanes: SignalsLanes): void;
		onPassDiscarded(root: SignalsFiberRoot, lanes: SignalsLanes): void;
		onCommitPhase(root: SignalsFiberRoot, phase: SignalsCommitPhase, lanes: SignalsLanes): void;
	}

	export interface ExternalSignalsSeam {
		inject(runtime: ExternalSignalsRuntime): () => void;
		runWithLane<T>(lane: number, fn: () => T): T;
		currentTransitionLane(): number;
		scheduleRootLane(root: SignalsFiberRoot, lane: number): void;
		isRenderPhase(): boolean;
	}

	export const unstable_externalSignals: ExternalSignalsSeam | undefined;
}
