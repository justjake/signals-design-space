import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Runtime } from 'strata-signals';
import { useSignal } from '../src/index.js';

test('server requests own independent runtimes and can hydrate lazy atoms', () => {
	const first = new Runtime();
	const second = new Runtime();
	const firstCount = first.atom(1);
	const secondCount = second.atom(8);

	function Count({ value }: { value: typeof firstCount }) {
		return <span>{useSignal(value)}</span>;
	}

	expect(renderToString(<Count value={firstCount} />)).toContain('1');
	expect(renderToString(<Count value={secondCount} />)).toContain('8');
	firstCount.set(2);
	expect(secondCount.state).toBe(8);

	const payload = first.serialize({ count: firstCount });
	let initialized = 0;
	const client = new Runtime();
	const hydrated = client.atom(() => {
		initialized++;
		return 0;
	});
	client.initialize(payload, { count: hydrated });
	expect(renderToString(<Count value={hydrated} />)).toContain('2');
	expect(initialized).toBe(0);
});
