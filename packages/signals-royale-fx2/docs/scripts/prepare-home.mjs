import { readFile, writeFile } from 'node:fs/promises'

const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')
const body = readme.replace(/^# signals-royale-fx2\n+/, '')
const playgrounds = {
	'## Core API': 'batch-effect',
	'## Intents, drafts, and transitions': 'transition',
	'## The read family': 'transition',
	'## Async values': 'async',
	'## Refetching': 'async',
	'## Observed lifecycle': 'lifecycle',
	'## Server rendering': 'ssr',
	'## Causality tracing': 'counter',
	'## React API': 'counter',
}

let section = ''
let insideCode = false
let homepage = ''
for (const line of body.split('\n')) {
	if (line.startsWith('## ')) section = line
	homepage += `${line}\n`
	if (line.startsWith('```')) {
		insideCode = !insideCode
		if (!insideCode && playgrounds[section] !== undefined) {
			homepage += `\n<Playground name="${playgrounds[section]}" />\n\n`
		}
	}
}
homepage = homepage.replace(
	'docs/effects.md',
	'https://github.com/justjake/signals-design-space/blob/main/packages/signals-royale-fx2/docs/effects.md',
)

await writeFile(
	new URL('../content/docs/index.mdx', import.meta.url),
	`---
title: signals-royale-fx2
description: Concurrent-safe signals for React 19.
icon: Orbit
---

${homepage}
`,
)
