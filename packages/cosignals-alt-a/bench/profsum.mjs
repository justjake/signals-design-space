/** Summarize a .cpuprofile: self-time by function, top N. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'bench/profiles'
const files = readdirSync(dir)
	.filter((f) => f.endsWith('.cpuprofile'))
	.sort()
const file = join(dir, files[files.length - 1])
const prof = JSON.parse(readFileSync(file, 'utf8'))

const nodesById = new Map(prof.nodes.map((n) => [n.id, n]))
const self = new Map()
const deltas = prof.timeDeltas ?? []
const samples = prof.samples ?? []
for (let i = 0; i < samples.length; ++i) {
	const node = nodesById.get(samples[i])
	if (!node) {
		continue
	}
	const fn = node.callFrame.functionName || '(anonymous)'
	const key = `${fn} ${node.callFrame.url.split('/').pop() ?? ''}:${node.callFrame.lineNumber}`
	self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0))
}
const total = [...self.values()].reduce((a, b) => a + b, 0)
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
console.log(`profile: ${file} — total ${(total / 1000).toFixed(1)}ms`)
for (const [k, us] of top) {
	console.log(
		`  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(1).padStart(8)}ms  ${k}`,
	)
}
