import { readFile, writeFile } from 'node:fs/promises'

const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')
const body = readme.replace(/^# signals-royale-fx2\n+/, '')
const introduction = body.slice(0, body.indexOf('## Core API')).trim()

await writeFile(
	new URL('../content/docs/index.mdx', import.meta.url),
	`---
title: signals-royale-fx2
description: Concurrent-safe signals for React 19.
icon: Orbit
---

${introduction}

## Try it

An atom stores a writable value. A computed derives a lazy, cached value and
tracks the signals read during its latest evaluation.

\`\`\`tsx
const count = createAtom(0, { label: 'count' })

function Counter() {
  const value = useValue(count)
  const doubled = useComputed(() => count.get() * 2, [])
  return <button onClick={() => count.update((n) => n + 1)}>{value} / {doubled}</button>
}
\`\`\`

<Playground name="counter" />

## Read next

- [Getting started](guides/getting-started) connects the React provider and
  builds the first component.
- [Core signals](guides/core-signals) covers reducer atoms, batching, equality,
  and read semantics.
- [Effects](guides/effects) keeps dependency tracking separate from side
  effects.
- [Transitions and async values](guides/transitions-and-async) shows why this
  engine has draft-aware snapshots.
- [API reference](api/reference) is generated from every public entry point's
  TSDoc comments.
`,
)
