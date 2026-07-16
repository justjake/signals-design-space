import { readdir, readFile, writeFile } from 'node:fs/promises'

const directory = new URL('../content/docs/api/reference/', import.meta.url)
const titles = {
	'debug.mdx': 'Debug API',
	'index-1.mdx': 'Core API',
	'index.mdx': 'API reference',
	'react.mdx': 'React API',
	'ssr.mdx': 'Server rendering API',
}

for (const file of await readdir(directory)) {
	if (!file.endsWith('.mdx')) continue
	const source = await readFile(new URL(file, directory), 'utf8')
	const heading = source.match(/^# (.+)$/m)?.[1]
	const title = titles[file] ?? heading
	if (title === undefined) throw new Error(`No title found for ${file}`)
	await writeFile(new URL(file, directory), source.replace('---\n', `---\ntitle: ${title}\n`))
}

await writeFile(
	new URL('meta.json', directory),
	JSON.stringify(
		{
			title: 'Generated API',
			pages: ['index', 'index-1', 'react', 'ssr', 'debug'],
		},
		null,
		2,
	) + '\n',
)
