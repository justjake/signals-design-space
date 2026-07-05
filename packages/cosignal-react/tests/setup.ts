/**
 * Suite setup: assert the LINKED fork is what we run against (task rule 5) —
 * capabilities 511 means fork surface v1; anything else means someone needs
 * `pnpm fork:build`. Also arms React's act() environment.
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
