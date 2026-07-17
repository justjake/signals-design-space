/**
 * The package's test adapter owns its conformance policy. This file only
 * changes the name used to join framework results in the root harness.
 */
import type { FrameworkAdapter } from './types'
import adapter from '../../packages/cosignals/royale/harness-adapter.ts'

const cosignals = {
	...adapter,
	name: 'cosignals',
} satisfies FrameworkAdapter

export default cosignals
