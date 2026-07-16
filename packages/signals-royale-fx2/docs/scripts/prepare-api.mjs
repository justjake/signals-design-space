import { readdir, readFile, rename, writeFile } from 'node:fs/promises'

const directory = new URL('../content/docs/api/reference/', import.meta.url)
await rename(new URL('index-1.mdx', directory), new URL('core.mdx', directory))

const titles = {
	'core.mdx': 'Core API',
	'debug.mdx': 'Debug API',
	'index.mdx': 'API reference',
	'react.mdx': 'React API',
	'ssr.mdx': 'Server rendering API',
}

for (const file of await readdir(directory)) {
	if (!file.endsWith('.mdx')) continue
	let source = await readFile(new URL(file, directory), 'utf8')
	source = source
		.replaceAll('index-1.mdx', 'core.mdx')
		.replaceAll('[index](core.mdx)', '[core](core.mdx)')
	if (file === 'core.mdx') {
		source = source.replace('/ index\n', '/ core\n').replace('\n# index\n', '\n# Core API\n')
	}
	if (file === 'react.mdx') {
		let insideCode = false
		let withPlaygrounds = ''
		for (const line of source.split('\n')) {
			withPlaygrounds += `${line}\n`
			if (line.startsWith('```')) {
				insideCode = !insideCode
				if (!insideCode) withPlaygrounds += '\n<Playground name="batch-effect" />\n\n'
			}
		}
		source = withPlaygrounds
	}
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
			pages: ['index', 'core', 'react', 'ssr', 'debug'],
		},
		null,
		2,
	) + '\n',
)
