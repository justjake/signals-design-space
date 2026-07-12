/**
 * Runs every scenario for ONE contender and prints CSV rows to stdout.
 *
 * One contender per process is structural, not a convenience: registering
 * cosignals-react patches Atom's prototype onto its concurrent engine
 * process-wide, and V8's JIT specializes hot call sites to whichever
 * library ran first — either would contaminate a second contender measured
 * in the same process. Per-scenario extra stats go to stderr as `#` comment
 * lines so stdout stays machine-parseable.
 *
 * Usage: node dist/child.js <contenderName>
 */
import { freshDom } from './scenarios/dom.js' // must stay the first import: installs DOM globals before react-dom/client evaluates
import { loadContender } from './adapters/index.js'
import { contenderNames } from './adapters/names.js'
import { scenarios } from './scenarios/index.js'
import type { Contender } from './adapters/types.js'
import { formatPerfResult } from './util/perfLogging.js'

// argv is typed string[] but a missing argument reads as undefined at runtime.
const name: string | undefined = process.argv[2]
if (name === undefined) {
	console.error(`usage: node dist/child.js <contender>; available: ${contenderNames.join(', ')}`)
	process.exit(1)
}

let contender: Contender
try {
	contender = await loadContender(name)
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
}

for (const scenario of scenarios) {
	freshDom()
	await scenario.run(contender, (ms, extra) => {
		console.log(
			formatPerfResult({ framework: contender.name, test: scenario.name, time: ms.toFixed(2) }),
		)
		if (extra !== undefined) {
			console.error(`# ${contender.name} ${scenario.name} ${JSON.stringify(extra)}`)
		}
	})
}

// Everything should be settled, so the process exits on its own; if a stray
// handle keeps the event loop alive anyway, exit once stdout has had a beat
// to flush. unref() keeps this failsafe from holding the loop open itself.
setTimeout(() => process.exit(0), 1000).unref()
