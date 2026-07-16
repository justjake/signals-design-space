import { defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { metaSchema, pageSchema } from 'fumapress/adapters/mdx/schema'

export const docs = defineDocs({
	dir: 'content/docs',
	docs: {
		async: true,
		schema: pageSchema,
		postprocess: { includeProcessedMarkdown: true },
	},
	meta: { schema: metaSchema },
})

export default defineConfig({
	mdxOptions: {
		rehypeCodeOptions: {
			themes: { light: 'vitesse-light', dark: 'catppuccin-mocha' },
		},
	},
})
