import { readdir, readFile } from 'node:fs/promises'

const content = new URL('../content/docs/', import.meta.url)
const files = []
const directories = [{ url: content, prefix: '' }]
while (directories.length > 0) {
	const directory = directories.pop()
	for (const entry of await readdir(directory.url, { withFileTypes: true })) {
		const path = `${directory.prefix}${entry.name}`
		if (entry.isDirectory()) {
			directories.push({ url: new URL(`${entry.name}/`, directory.url), prefix: `${path}/` })
		} else if (entry.name.endsWith('.mdx')) {
			files.push(path)
		}
	}
}

for (const file of files) {
	const source = await readFile(new URL(file, content), 'utf8')
	const fences = file.startsWith('api/')
		? (source.match(/^```tsx$/gm)?.length ?? 0) * 2
		: source.match(/^```/gm)?.length ?? 0
	const playgrounds = source.match(/<Playground name="[^"]+" \/>/g)?.length ?? 0
	if (fences % 2 !== 0 || fences / 2 > playgrounds) {
		throw new Error(`${file}: found ${fences / 2} code examples and ${playgrounds} playgrounds`)
	}
}
