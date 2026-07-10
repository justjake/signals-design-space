#!/usr/bin/env node
/**
 * Render a markdown ratio table from harness bench result JSON files
 * (the `harness/results/<stamp>-<framework>.json` files written by
 * bench/run.ts, or `<stamp>-memory-<framework>.json` from memory/run.ts).
 *
 * Ratios are computed against a baseline framework so the table is robust
 * to machine load: absolute times move with the machine, same-invocation
 * ratios mostly do not (see harness/README.md methodology notes). The
 * baseline column shows the absolute number; every other column shows
 * value/baseline.
 *
 * When several files cover the same (framework, test) cell — e.g. two
 * interleaved passes — the MINIMUM is used (external interference only ever
 * adds time, so min is the honest estimator).
 *
 * Usage:
 *   node harness/util/ratio-table.mjs --baseline alien-v3 [--suite kairo] \
 *     [--metric time|kb] harness/results/2026-07-06*.json
 *
 * Zero dependencies; safe to run in CI before any install step completes.
 */
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
let baseline = 'alien-v3'
let suiteFilter = null
let metric = null // auto: 'time' for bench rows, 'kb' for memory rows
const files = []
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--baseline') baseline = argv[++i]
	else if (argv[i] === '--suite') suiteFilter = argv[++i]
	else if (argv[i] === '--metric') metric = argv[++i]
	else files.push(argv[i])
}
if (files.length === 0) {
	console.error('usage: ratio-table.mjs [--baseline fw] [--suite s] [--metric m] result.json...')
	process.exit(1)
}

// cells: rowKey -> framework -> min value; column order = first-seen order.
const cells = new Map()
const frameworks = []
const rowKeys = []
for (const file of files) {
	let doc
	try {
		doc = JSON.parse(readFileSync(file, 'utf8'))
	} catch (err) {
		console.error(`skipping ${file}: ${err instanceof Error ? err.message : err}`)
		continue
	}
	for (const row of doc.rows ?? []) {
		if (suiteFilter !== null && row.suite !== suiteFilter) continue
		const m = metric ?? (row.time !== undefined ? 'time' : 'kb')
		const value = Number(row[m])
		if (!Number.isFinite(value)) continue
		const rowKey =
			row.suite !== undefined ? `${row.suite}/${row.test}` : String(row.metric ?? row.test)
		const fw = String(row.framework)
		if (!cells.has(rowKey)) {
			cells.set(rowKey, new Map())
			rowKeys.push(rowKey)
		}
		const perFw = cells.get(rowKey)
		const prev = perFw.get(fw)
		if (prev === undefined || value < prev) perFw.set(fw, value)
		if (!frameworks.includes(fw)) frameworks.push(fw)
	}
}

if (rowKeys.length === 0) {
	console.error('no rows matched')
	process.exit(1)
}
// Baseline column first, then the rest in first-seen order.
const cols = [baseline, ...frameworks.filter((f) => f !== baseline)]
const unit = (metric ?? 'time') === 'kb' ? 'kb' : 'ms'

console.log(`| test | ${cols.map((c, i) => (i === 0 ? `${c} (${unit})` : c)).join(' | ')} |`)
console.log(`| --- | ${cols.map(() => '---:').join(' | ')} |`)
for (const rowKey of rowKeys) {
	const perFw = cells.get(rowKey)
	const base = perFw.get(baseline)
	const rendered = cols.map((fw, i) => {
		const v = perFw.get(fw)
		if (v === undefined) return '—'
		if (i === 0) return v.toFixed(2)
		if (base === undefined || base === 0) return v.toFixed(2) + unit
		return `${(v / base).toFixed(2)}x`
	})
	console.log(`| ${rowKey} | ${rendered.join(' | ')} |`)
}

// Geomean-of-ratios footer: one robust scalar per framework (only over rows
// where both that framework and the baseline have values).
const footer = cols.map((fw, i) => {
	if (i === 0) return '1.00x'
	let logSum = 0
	let n = 0
	for (const rowKey of rowKeys) {
		const perFw = cells.get(rowKey)
		const v = perFw.get(fw)
		const base = perFw.get(baseline)
		if (v === undefined || base === undefined || base <= 0 || v <= 0) continue
		logSum += Math.log(v / base)
		n++
	}
	return n === 0 ? '—' : `${Math.exp(logSum / n).toFixed(2)}x`
})
console.log(`| **geomean ratio** | ${footer.join(' | ')} |`)
