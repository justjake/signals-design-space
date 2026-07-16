import { readdir, readFile } from 'node:fs/promises'

const content = new URL('../content/docs/', import.meta.url)
const files = ['index.mdx']
for (const file of await readdir(new URL('guides/', content))) {
	if (file.endsWith('.mdx')) files.push(`guides/${file}`)
}

for (const file of files) {
	const source = await readFile(new URL(file, content), 'utf8')
	const fences = source.match(/^```/gm)?.length ?? 0
	const playgrounds = source.match(/<Playground name="[^"]+" \/>/g)?.length ?? 0
	if (fences % 2 !== 0 || fences / 2 !== playgrounds) {
		throw new Error(`${file}: found ${fences / 2} code examples and ${playgrounds} playgrounds`)
	}
}
