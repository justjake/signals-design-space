import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const rootDirectory = process.cwd()
const planPath = resolve(rootDirectory, process.argv[2] ?? 'release-plan.json')
const artifactsDirectory = resolve(rootDirectory, process.argv[3] ?? 'release-artifacts')
const plan = JSON.parse(await readFile(planPath, 'utf8'))

await rm(artifactsDirectory, { recursive: true, force: true })
await mkdir(artifactsDirectory, { recursive: true })
const stagingRoot = await mkdtemp(join(tmpdir(), 'cosignals-release-pack-'))

try {
	for (const release of plan) {
		const packageDirectory = resolve(rootDirectory, release.directory)
		const sourceManifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
		const stagingDirectory = join(stagingRoot, release.name)
		await mkdir(stagingDirectory, { recursive: true })
		await cp(join(packageDirectory, 'dist'), join(stagingDirectory, 'dist'), { recursive: true })
		await cp(join(packageDirectory, 'README.md'), join(stagingDirectory, 'README.md'))

		const exports = {}
		for (const [subpath, source] of Object.entries(sourceManifest.exports)) {
			if (typeof source !== 'string' || !source.startsWith('./src/') || !/\.tsx?$/.test(source)) {
				throw new Error(`Unsupported export ${release.name} ${subpath}: ${source}`)
			}
			exports[subpath] = {
				types: source.replace('./src/', './dist/').replace(/\.tsx?$/, '.d.ts'),
				import: source.replace('./src/', './dist/').replace(/\.tsx?$/, '.js'),
			}
		}

		const dependencies = {}
		for (const [name, version] of Object.entries(sourceManifest.dependencies ?? {})) {
			if (!version.startsWith('workspace:')) {
				dependencies[name] = version
				continue
			}
			let publishedVersion
			for (const dependencyRelease of plan) {
				if (dependencyRelease.name === name) publishedVersion = dependencyRelease.version
			}
			if (publishedVersion === undefined) {
				throw new Error(`${release.name} depends on unpublished workspace package ${name}`)
			}
			dependencies[name] = publishedVersion
		}

		const manifest = {
			name: release.name,
			version: release.version,
			description: sourceManifest.description,
			type: sourceManifest.type,
			exports,
			files: ['dist'],
			repository: {
				type: 'git',
				url: 'git+https://github.com/justjake/signals-design-space.git',
				directory: release.directory,
			},
			publishConfig: { access: 'public' },
		}
		if (Object.keys(dependencies).length !== 0) manifest.dependencies = dependencies
		if (sourceManifest.peerDependencies !== undefined) manifest.peerDependencies = sourceManifest.peerDependencies
		if (sourceManifest.peerDependenciesMeta !== undefined) manifest.peerDependenciesMeta = sourceManifest.peerDependenciesMeta
		await writeFile(join(stagingDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

		execFileSync('pnpm', ['pack', '--pack-destination', artifactsDirectory], {
			cwd: stagingDirectory,
			stdio: 'inherit',
		})
	}
} finally {
	await rm(stagingRoot, { recursive: true, force: true })
}

await cp(planPath, join(artifactsDirectory, 'release-plan.json'))
