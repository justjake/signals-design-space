/**
 * Suite setup: assert the React build we run against actually implements
 * the cosignal external-runtime protocol — capabilities 511 means every
 * version-1 capability is present; anything else means the patched React
 * build is stale or missing (`pnpm fork:build` rebuilds it). Also arms
 * React's act() environment.
 */
import * as React from 'react';

const proto = React.unstable_externalRuntimeProtocol;
if (proto === undefined || proto.capabilities !== 511) {
	throw new Error(
		`cosignal-react tests: expected the linked fork (unstable_externalRuntimeProtocol.capabilities === 511), ` +
			`got ${proto === undefined ? 'no protocol (stock React?)' : String(proto.capabilities)} — run pnpm fork:build.`,
	);
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
