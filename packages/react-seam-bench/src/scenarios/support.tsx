/**
 * Shared scenario plumbing: mounts an n-cell tree under a React Profiler
 * with a module-level cell render counter, and settles React work by
 * polling the committed DOM with real timers. No act(): act() flattens the
 * very scheduling differences under measurement (a synchronous blocking
 * flush and a chunked concurrent render both look instant inside act), so
 * scenarios instead await setTimeout(0) loops until a rendered sentinel
 * matches. All timing uses performance.now().
 */
import './dom.js';
import { memo, Profiler, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { CellStore } from '../adapters/types.js';

let cellRenders = 0;
/** Total cell-component render count since process start; scenarios diff it around writes. */
export function cellRenderCount(): number {
	return cellRenders;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A few macrotask hops so scheduler tasks, passive effects, and
 * microtask-debounced work all run — cosignals-react finalizes watcher
 * teardown on a debounced microtask after unmount, so measurement phases
 * must drain between each other or teardown bleeds into the next timing.
 */
export async function drain(hops = 5): Promise<void> {
	for (let i = 0; i < hops; i++) await sleep(0);
}

export async function until(pred: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
	const started = performance.now();
	while (!pred()) {
		if (performance.now() - started > timeoutMs) {
			throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
		}
		await sleep(0);
	}
}

export function median(xs: number[]): number {
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function p95(xs: number[]): number {
	const sorted = [...xs].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export interface ProfilerTotals {
	commits: number;
	actualDurationMs: number;
}

export interface TreeHandle {
	container: HTMLElement;
	profiler: ProfilerTotals;
	/** Committed text of cell i, or null before its first commit. */
	readCell(i: number): string | null;
	unmount(): Promise<void>;
}

/**
 * Creates a root and starts rendering n cells (plus an optional extra
 * subtree, e.g. the urgent input in the transition scenario). Returns
 * without awaiting anything so callers can time the commit themselves by
 * polling readCell. Cell components are memo'd for every contender — for
 * the context baseline that memo deliberately cannot help, since context
 * updates bypass it.
 */
export function renderCells(store: CellStore, n: number, extra?: ReactNode): TreeHandle {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const profiler: ProfilerTotals = { commits: 0, actualDurationMs: 0 };

	const Cell = memo(function Cell({ i }: { i: number }) {
		cellRenders++;
		const v = store.useCell(i);
		return <span id={'c' + i}>{v}</span>;
	});

	function CellList() {
		const items: ReactNode[] = [];
		for (let i = 0; i < n; i++) items.push(<Cell key={i} i={i} />);
		return <div>{items}</div>;
	}

	let tree: ReactNode = (
		<>
			{extra}
			<CellList />
		</>
	);
	const Provider = store.Provider;
	if (Provider !== undefined) tree = <Provider>{tree}</Provider>;

	const root = createRoot(container);
	root.render(
		<Profiler
			id="cells"
			onRender={(_id, _phase, actualDuration) => {
				profiler.commits++;
				profiler.actualDurationMs += actualDuration;
			}}
		>
			{tree}
		</Profiler>,
	);

	return {
		container,
		profiler,
		readCell(i: number): string | null {
			const el = document.getElementById('c' + i);
			return el === null ? null : el.textContent;
		},
		async unmount(): Promise<void> {
			root.unmount();
			container.remove();
			await drain();
		},
	};
}
