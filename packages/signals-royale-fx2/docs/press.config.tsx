import { docs } from './.source/server'
import { Playground } from './src/playground'
import defaultMdxComponents, { createRelativeLink } from 'fumadocs-ui/mdx'
import { fumadocsMdx } from 'fumapress/adapters/mdx'
import { defineConfig } from 'fumapress'
import { flexsearchPlugin } from 'fumapress/plugins/flexsearch'
import { llmsPlugin } from 'fumapress/plugins/llms.txt'

export default defineConfig({
	content: docs.toFumadocsSource(),
	site: {
		name: 'signals-royale-fx2',
		git: {
			user: 'justjake',
			repo: 'signals-design-space',
			branch: 'main',
		},
	},
	meta: {
		root() {
			return (
				<>
					<link rel="preconnect" href="https://fonts.googleapis.com" />
					<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
					<link
						href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
						rel="stylesheet"
					/>
				</>
			)
		},
	},
})
	.adapters(
		fumadocsMdx({
			async getMdxComponents(page) {
				const source = await this.getLoader()
				return {
					...defaultMdxComponents,
					a: createRelativeLink(source, page),
					Playground,
				}
			},
		}),
	)
	.plugins(flexsearchPlugin(), llmsPlugin())
