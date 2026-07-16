import { readFile, writeFile } from 'node:fs/promises'

const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')
const body = readme
	.replace(/^# signals-royale-fx2\n+/, '')
	.replaceAll('docs/effects.md', 'guides/effects')

await writeFile(
	new URL('../content/docs/index.mdx', import.meta.url),
	`---\ntitle: signals-royale-fx2\ndescription: Concurrent-safe signals for React 19.\nicon: Orbit\n---\n\n${body}`,
)
