/**
 * Runs the benchmark with each contender in its own node process, so that
 * one contender's JIT warmup, GC pressure, and polymorphic call sites can't
 * affect another contender's numbers — and because cosignals'
 * registration is once-per-process and patches Atom's prototype, two
 * contenders sharing a process would be wrong, not merely noisy.
 *
 * Contenders run in ROUNDS, round-robin (A B C, A B C, ...), and each
 * test's final time is the MEDIAN of its per-round times. Interleaving
 * decorrelates slow machine drift (thermals, background load) from any one
 * contender, and the median discards lucky/unlucky rounds — on a laptop a
 * single sequential pass can move totals by more than the gaps measured.
 * No forced GC between tests: forced collections evict every contender's
 * working set, which distorts comparisons more than the cross-test GC
 * billing they remove.
 *
 * Exits 1 if any requested contender produced zero result rows.
 *
 * Usage: node dist/isolated.js [--rounds N] [contenderName...]
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contenderNames } from './adapters/names.js'
import { formatPerfResult, perfResultHeaders } from './util/perfLogging.js'

const childJs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'child.js')

const argv = process.argv.slice(2)
let rounds = 3
const roundsAt = argv.indexOf('--rounds')
if (roundsAt !== -1) {
	rounds = Number(argv[roundsAt + 1])
	if (!Number.isInteger(rounds) || rounds < 1) {
		console.error('--rounds expects a positive integer')
		process.exit(1)
	}
	argv.splice(roundsAt, 2)
}

const names: readonly string[] = contenderNames
const requested = argv
const unknown = requested.filter((name) => !names.includes(name))
if (unknown.length > 0) {
	console.error(`unknown contenders: ${unknown.join(', ')}; available: ${names.join(', ')}`)
	process.exit(1)
}
const selected = requested.length > 0 ? requested : [...names]

function medianOf(times: number[]): number {
	const sorted = [...times].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// (contender, test) -> per-round times; test order preserved per contender.
const samples = new Map<string, Map<string, number[]>>()
for (const name of selected) {
	samples.set(name, new Map())
}

for (let round = 0; round < rounds; round++) {
	for (const name of selected) {
		console.error(`round ${round + 1}/${rounds}: ${name}`)
		const result = spawnSync(process.execPath, [childJs, name], {
			stdio: ['ignore', 'pipe', 'inherit'],
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		})
		if (result.status !== 0) {
			console.error(
				`⚠ ${name} round ${round + 1} exited with ${
					result.status !== null ? `code ${result.status}` : result.signal
				} (keeping rows from its other rounds)`,
			)
		}
		const perTest = samples.get(name)!
		for (const line of (result.stdout ?? '').split('\n')) {
			const parts = line.split(',').map((p) => p.trim())
			if (parts.length < 3 || parts[0] !== name) {
				continue
			}
			const time = Number(parts[2])
			if (!Number.isFinite(time)) {
				continue
			}
			let arr = perTest.get(parts[1])
			if (arr === undefined) {
				arr = []
				perTest.set(parts[1], arr)
			}
			arr.push(time)
		}
	}
}

console.log(formatPerfResult(perfResultHeaders()))
for (const name of selected) {
	const perTest = samples.get(name)!
	for (const [test, times] of perTest) {
		if (times.length < rounds) {
			console.error(`⚠ ${name} / ${test}: only ${times.length}/${rounds} rounds completed`)
		}
		console.log(
			formatPerfResult({
				framework: name,
				test,
				time: medianOf(times).toFixed(2),
			}),
		)
	}
}

// A contender that crashed every round has a header entry but no rows; that
// is a failed run, not a partial one.
const empty = selected.filter((name) => samples.get(name)!.size === 0)
if (empty.length > 0) {
	console.error(`✗ no results for: ${empty.join(', ')}`)
}
process.exit(empty.length > 0 ? 1 : 0)
