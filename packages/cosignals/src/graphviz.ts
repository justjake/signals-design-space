/**
 * `cosignals/graphviz` — emits engine diagnostics as DOT source (Graphviz's
 * text graph format; render with `dot -Tsvg`). Imports are types only, so
 * this entry's runtime module graph is exactly this one file. Legend:
 *  - shapes: box = atom; ellipse = computed; house = watcher (one subscribed
 *    UI component); cds = SignalEffect (a committed-world graph terminal)
 *  - edges: solid = dependency; dashed = watcher's node; dotted = effect dep
 *  - `log:N` = N recorded writes not yet folded into the atom's base value
 */

import type { CosignalEngine } from './CosignalEngine.js'
import type { TraceRecord, TraceKind } from './Tracer.js'

/** Escape + quote a string as a DOT-source string literal. */
function quoteDotString(s: string): string {
	return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Snapshot of the live dependency graph: nodes, recorded dependency edges, observers. */
export function dependencyGraphToDot(engine: CosignalEngine): string {
	const lines: string[] = ['digraph cosignals {', '\trankdir=LR;', '\tnode [fontname="monospace"];']
	for (const n of engine.idToInternals.values()) {
		if (n.kind === 'atom') {
			const log = n.log.length > 0 ? `|log:${n.log.length}` : ''
			lines.push(`\tn${n.id} [shape=box, label=${quoteDotString(`${n.name}#${n.id}${log}`)}];`)
		} else {
			lines.push(`\tn${n.id} [shape=ellipse, label=${quoteDotString(`${n.name}#${n.id}`)}];`)
		}
	}
	for (const [dep, outs] of engine.dependencyEdges) {
		for (const out of outs) lines.push(`\tn${dep} -> n${out};`)
	}
	for (const w of engine.watchers.values()) {
		if (!w.live) continue
		lines.push(`\tw${w.id} [shape=house, label=${quoteDotString(`${w.name}@${w.root}`)}];`)
		lines.push(`\tn${w.node} -> w${w.id} [style=dashed];`)
	}
	for (const effect of engine.idToSignalEffect.values()) {
		lines.push(
			`\te${effect.id} [shape=cds, label=${quoteDotString(`${effect.name}@${effect.root} runs:${effect.runs}`)}];`,
		)
		for (const dep of effect.deps) lines.push(`\tn${dep.node.id} -> e${effect.id} [style=dotted];`)
	}
	lines.push('}')
	return lines.join('\n')
}

/** The causal graph of a decoded trace slice (edges: cause → event); `filter` keeps matching events only. */
export function traceToDot(events: TraceRecord[], filter?: (e: TraceRecord) => boolean): string {
	const kept: TraceRecord[] = filter === undefined ? events : []
	const ids = new Set<number>()
	for (const event of events) {
		if (filter === undefined || filter(event)) {
			if (filter !== undefined) kept.push(event)
			ids.add(event.id)
		}
	}
	const lines: string[] = ['digraph trace {', '\tnode [fontname="monospace", shape=box];']
	const shade: Partial<Record<TraceKind, string>> = {
		write: 'lightblue',
		'batch-retire': 'lightyellow',
		'root-commit': 'lightyellow',
		'render-end': 'lightyellow',
		delivery: 'lightgreen',
		suppressed: 'lightgray',
		'mount-correction': 'salmon',
		'reconcile-correction': 'salmon',
		truncation: 'red',
	}
	for (const e of kept) {
		const subject = Object.values(e.data)[0]
		const label = `#${e.id} ${e.kind}(${typeof subject === 'string' ? subject : String(subject)})`
		const fill = shade[e.kind]
		const style = fill === undefined ? '' : `, style=filled, fillcolor=${fill}`
		lines.push(`\tt${e.id} [label=${quoteDotString(label)}${style}];`)
	}
	for (const e of kept) {
		if (e.cause !== undefined && ids.has(e.cause)) lines.push(`\tt${e.cause} -> t${e.id};`)
	}
	lines.push('}')
	return lines.join('\n')
}
