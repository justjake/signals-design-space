/**
 * The one demo app, shared verbatim by every entrypoint. Everything
 * reactive comes from '#concurrent-signals-shim' — this file never names a
 * concrete implementation, so the same tree exercises whichever engine the
 * current page selected.
 */
import * as React from 'react';
import {
	createAtom,
	createComputed,
	name,
	startSignalTransition,
	useComputed,
	useSignal,
	useSignalEffect,
} from '#concurrent-signals-shim';

// ---- module-level store -----------------------------------------------------------
// Created at module init, before main.tsx calls register(): all three
// engines allocate signal records without touching React, so creation-time
// order is safe. Shared by every component below.

const count = createAtom(0, 'count');
const doubled = createComputed(() => count.state * 2, 'doubled');
const parity = createComputed(() => (count.state % 2 === 0 ? 'even' : 'odd'), 'parity');
// Reads two signals that must always agree: any render that mixed worlds
// (count from one write, doubled from another) would render TORN.
const consistency = createComputed(
	() => (doubled.state === count.state * 2 ? 'consistent' : 'TORN'),
	'consistency',
);

const ROW_COUNT = 800;
const listSeed = createAtom(1, 'listSeed');

/** Deterministic per-row hash: every seed change visibly changes every row,
 * so one reseed re-renders the whole list section. */
function rowValue(seed: number, index: number): number {
	let h = Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35);
	h ^= h >>> 15;
	return (h >>> 0) % 100000;
}

// ---- sections ----------------------------------------------------------------------

function CounterSection(): React.ReactElement {
	const value = useSignal(count);
	const twice = useSignal(doubled);
	const parityText = useSignal(parity);
	const agreement = useSignal(consistency);

	// Committed-world side effect: the title tracks what the user actually
	// sees, so it lags pending transitions instead of revealing them early.
	useSignalEffect(() => {
		document.title = `${name} · count ${count.state}`;
	}, []);

	return (
		<section>
			<h2>counter</h2>
			<p>
				count <output data-testid="count">{value}</output> · doubled{' '}
				<output data-testid="doubled">{twice}</output> · parity{' '}
				<output data-testid="parity">{parityText}</output> ·{' '}
				<output data-testid="consistency">{agreement}</output>
			</p>
			<button type="button" data-testid="increment" onClick={() => count.update((c) => c + 1)}>
				+1 urgent
			</button>{' '}
			<button
				type="button"
				data-testid="increment-transition"
				onClick={() => startSignalTransition(() => count.update((c) => c + 10))}
			>
				+10 in transition
			</button>
		</section>
	);
}

function ScaledSection(): React.ReactElement {
	const [factor, setFactor] = React.useState(3);
	// Component-scoped derived value: `factor` is ordinary React state, so it
	// belongs in deps; the count read is tracked by the engine, not by deps.
	const scaled = useComputed(() => count.state * factor, [factor]);
	return (
		<section>
			<h2>useComputed</h2>
			<p>
				count × <output data-testid="factor">{factor}</output> ={' '}
				<output data-testid="scaled">{scaled}</output>
			</p>
			<button type="button" data-testid="factor-up" onClick={() => setFactor((f) => f + 1)}>
				factor +1
			</button>
		</section>
	);
}

function Row({ index }: { index: number }): React.ReactElement {
	const value = useComputed(() => rowValue(listSeed.state, index), [index]);
	return (
		<li data-testid={index === 0 ? 'row-0' : undefined} style={{ padding: '0 0.25rem' }}>
			{value}
		</li>
	);
}

const rowIndexes: readonly number[] = Array.from({ length: ROW_COUNT }, (_, i) => i);

function ListSection(): React.ReactElement {
	const seed = useSignal(listSeed);
	return (
		<section>
			<h2>list stress</h2>
			<p>
				seed <output data-testid="seed">{seed}</output> · {ROW_COUNT} rows, each its own
				useComputed subscriber
			</p>
			<button
				type="button"
				data-testid="reseed-transition"
				onClick={() => startSignalTransition(() => listSeed.update((s) => s + 1))}
			>
				reseed in transition
			</button>{' '}
			<button type="button" data-testid="reseed-urgent" onClick={() => listSeed.update((s) => s + 1)}>
				reseed urgent
			</button>
			<ol
				style={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: '2px',
					listStyle: 'none',
					margin: '1rem 0 0',
					padding: 0,
					fontFamily: 'monospace',
					fontSize: '11px',
				}}
			>
				{rowIndexes.map((i) => (
					<Row key={i} index={i} />
				))}
			</ol>
		</section>
	);
}

export function App(): React.ReactElement {
	return (
		<main style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem auto', maxWidth: '52rem' }}>
			<header>
				<h1>react-signals-playground</h1>
				<p>
					implementation: <strong data-testid="impl-name">{name}</strong>
				</p>
				<nav>
					<a href="/">cosignals</a> · <a href="/alt-a/">alt-a</a> · <a href="/alt-b/">alt-b</a>
				</nav>
			</header>
			<CounterSection />
			<ScaledSection />
			<ListSection />
		</main>
	);
}
