// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { atom, set, startTransitionWrite, useValue, update } from '../src/index.ts';
import { act, makeHarness, React } from './helpers.tsx';

let harness = makeHarness();
afterEach(async () => {
	await harness.cleanup();
	harness = makeHarness();
});

describe('smoke', () => {
	test('urgent write commits one pass', async () => {
		const a = atom(1, { label: 'a' });
		let renders = 0;
		function View() {
			renders++;
			return <span>{useValue(a)}</span>;
		}
		const { container } = await harness.mount(<View />);
		expect(container.textContent).toBe('1');
		renders = 0;
		await act(async () => {
			set(a, 2);
		});
		expect(container.textContent).toBe('2');
		expect(renders).toBe(1);
	});

	test('transition write: draft hidden from committed DOM until it lands', async () => {
		const a = atom('base', { label: 'a' });
		function View() {
			return <span>{useValue(a)}</span>;
		}
		const { container } = await harness.mount(<View />);
		let sawDuring: string | null = null;
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 'draft');
			});
			sawDuring = container.textContent;
		});
		expect(sawDuring).toBe('base');
		expect(container.textContent).toBe('draft');
	});

	test('urgent during transition: transition +1 then urgent x2 = 2 now, (1+1)*2 = 4 after', async () => {
		const a = atom(1, { label: 'counter' });
		function View() {
			return <span>{useValue(a)}</span>;
		}
		const { container } = await harness.mount(<View />);
		await act(async () => {
			startTransitionWrite(() => {
				update(a, (x) => x + 1);
			});
			update(a, (x) => x * 2);
		});
		// The urgent doubling committed alone (1*2 = 2); retirement replayed
		// the full write log in call order: (1+1)*2 = 4.
		expect(container.textContent).toBe('4');
	});
});
