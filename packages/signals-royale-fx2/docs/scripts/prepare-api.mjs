import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

const generated = new URL('../.generated-api/', import.meta.url)
const output = new URL('../content/docs/api/', import.meta.url)
await rename(new URL('index-1.mdx', generated), new URL('core.mdx', generated))
await rm(new URL('reference/', output), { recursive: true, force: true })
for (const file of await readdir(output)) {
	if (file.endsWith('.mdx')) await rm(new URL(file, output))
}

const titles = {
	'core.mdx': 'Core API',
	'debug.mdx': 'Debug API',
	'index.mdx': 'API reference',
	'react.mdx': 'React API',
	'ssr.mdx': 'Server rendering API',
}

for (const file of await readdir(generated)) {
	if (!file.endsWith('.mdx') || file === 'index.mdx') continue
	let source = await readFile(new URL(file, generated), 'utf8')
	source = source
		.replaceAll('index-1.mdx', 'core.mdx')
		.replaceAll('[index](core.mdx)', '[core](core.mdx)')
	if (file === 'react.mdx') {
		let insideCode = false
		let example = false
		let withPlaygrounds = ''
		for (const line of source.split('\n')) {
			withPlaygrounds += `${line}\n`
			if (line.startsWith('```')) {
				if (!insideCode) example = line === '```tsx'
				insideCode = !insideCode
				if (!insideCode && example) {
					withPlaygrounds += '\n<Playground name="batch-effect" />\n\n'
				}
			}
		}
		source = withPlaygrounds
	}
	const heading = source.match(/^# (.+)$/m)?.[1]
	const title = titles[file] ?? heading
	if (title === undefined) throw new Error(`No title found for ${file}`)
	await writeFile(new URL(file, output), source.replace('---\n', `---\ntitle: ${title}\n`))
}
