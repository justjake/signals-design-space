/**
 * Regression pin for the per-instance React binding (convergence-refactor
 * review, bug 8). registerCosignalReact(instance) binds a specific
 * createCosignals() instance — the synchronous-SSR path — so hooks resolve
 * that instance's handles; a handle from a different instance throws a clear
 * ownership error instead of resolving against the wrong arena. The default
 * (no-argument) path is covered by the rest of the suite.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { Atom as DefaultAtom, createCosignals } from 'cosignals';
import { registerCosignalReact, useSignal } from '../src/index.js';

describe('bug 8: registerCosignalReact(instance) binds a per-request instance', () => {
	it('reads and updates per-instance handles, and rejects foreign ones', async () => {
		const inst = createCosignals();
		const count = new inst.Atom(7); // a per-instance handle (not the default instance's)
		const handle = registerCosignalReact(inst);
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			expect(handle.bridge).toBe(inst.engine); // bound to the passed instance

			function View(): React.ReactElement {
				return <span>{useSignal(count)}</span>;
			}
			// A per-instance handle is recognized by brand (not instanceof the
			// default class) and routed through the bound instance.
			await act(async () => {
				root.render(<View />);
			});
			expect(container.textContent).toBe('7');

			await act(async () => {
				count.set(9);
			});
			expect(container.textContent).toBe('9');

			// A handle owned by a DIFFERENT instance throws a clear error rather
			// than silently reading the wrong graph.
			const foreign = new DefaultAtom(0);
			expect(() => handle.shim.internalsForAtom(foreign)).toThrow(/different engine instance/);

			await act(async () => {
				root.unmount();
			});
		} finally {
			container.remove();
			handle.dispose();
		}
	});
});
