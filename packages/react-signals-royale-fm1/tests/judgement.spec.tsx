// @vitest-environment jsdom
/**
 * Real-React gate, scenarios 19-21 (judgement round): direct engine
 * atom.set() during a live transition, mixed engine + component subscribers
 * on one atom, and latest() inside a render body.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { discardBatch, openBatch, withAmbientBatch, write } from 'signals-royale-fm1';
import { atom, effect, latest, set, startTransitionWrite, update, useValue } from '../src/index.ts';
import { act, makeHarness, React, tick } from './helpers.tsx';

let harness = makeHarness();
afterEach(async () => {
	await harness.cleanup();
	harness = makeHarness();
});

describe('19. direct engine atom.set() during a live transition', () => {
	test('the urgent set folds canonically and survives the retirement replay', async () => {
		const a = atom(1, { label: 'a' });
		function View() {
			return <span>{useValue(a)}</span>;
		}
		const { container } = await harness.mount(<View />);
		await act(async () => {
			startTransitionWrite(() => {
				update(a, (x) => x * 2);
			});
			// Plain engine-API set — no classification wrapper, no flushSync.
			a.set(10);
			await tick();
		});
		// Call-order replay at retirement: x2 then the urgent set 10. A set
		// that bypassed the rebase log would be silently undone — retirement
		// would replay x2 over the stale base and land 2.
		expect(a.peek()).toBe(10);
		expect(container.textContent).toBe('10');
	});
});

describe('20. mixed engine and component subscribers on one atom', () => {
	test('one lifetime observation across the union; closes when both are gone', async () => {
		const observations: string[] = [];
		const a = atom(0, {
			label: 'a',
			onObserved: () => {
				observations.push('open');
				return () => observations.push('close');
			},
		});
		const effectSeen: number[] = [];
		const disposeEffect = effect(() => effectSeen.push(a.get()));
		function View() {
			return <span>{useValue(a)}</span>;
		}
		const { root, container } = await harness.mount(<View />);
		await act(async () => {
			await tick();
		});
		// Exactly one observation across the union of subscriber kinds.
		expect(observations).toEqual(['open']);
		// Deliveries reach both legs.
		await act(async () => {
			set(a, 1);
		});
		expect(container.textContent).toBe('1');
		expect(effectSeen).toEqual([0, 1]);
		// Dropping one leg keeps the observation open...
		disposeEffect();
		await act(async () => {
			await tick();
		});
		expect(observations).toEqual(['open']);
		// ...and it closes only when the last leg unsubscribes.
		await act(async () => {
			root.unmount();
			await tick();
		});
		expect(observations).toEqual(['open', 'close']);
	});
});

describe('21. latest() inside a render body', () => {
	test('resolves the render pass world, not the ambient newest draft', async () => {
		const a = atom(0, { label: 'a' });
		/** [useValue, latest] pairs per render pass — they must always agree. */
		const perRender: Array<[number, number | undefined]> = [];
		function View() {
			const v = useValue(a);
			perRender.push([v, latest(a)]);
			return <span>{v}</span>;
		}
		const { container } = await harness.mount(<View />);
		// An engine-level draft outside any React lane: the ambient newest,
		// but no render pass ever carries it.
		const stray = openBatch();
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 1);
			});
			withAmbientBatch(stray, () => write(a, 99));
			// Outside a render pass, latest() sees the ambient newest draft...
			expect(latest(a)).toBe(99);
			await tick();
		});
		// ...but inside every render body it resolved that pass's own world:
		// latest agreed with useValue in each pass and never leaked the 99.
		expect(perRender.length).toBeGreaterThan(0);
		for (const [rendered, latestSeen] of perRender) {
			expect(latestSeen).toBe(rendered);
		}
		expect(container.textContent).toBe('1');
		await act(async () => {
			discardBatch(stray);
			await tick();
		});
	});
});
