/**
 * Suite setup: assert the React build we run against actually implements
 * the cosignals external-runtime protocol — the entry points do not exist
 * on stock React, and a missing one means the patched React build is stale
 * or missing (`pnpm fork:build` rebuilds it). Also arms React's act()
 * environment.
 */
import * as React from 'react';

if (typeof React.subscribeToExternalRuntime !== 'function') {
	throw new Error(
		'cosignals-react tests: expected the linked fork (React.subscribeToExternalRuntime is missing — stock React?) — run pnpm fork:build.',
	);
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
