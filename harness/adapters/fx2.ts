/**
 * The package's test adapter owns its conformance policy. This file only
 * changes the name used to join framework results in the root harness.
 */
import type { FrameworkAdapter } from './types'
import adapter from '../../packages/signals-royale-fx2/royale/harness-adapter.ts'

const fx2 = {
	...adapter,
	name: 'fx2',
} satisfies FrameworkAdapter

export default fx2
