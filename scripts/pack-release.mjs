import { execFileSync } from "node:child_process"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

// Pack each planned release with `pnpm pack` against the real package
// directory, so the published artifact is exactly what the manifests say:
// pnpm applies the `files` allowlist, rewrites `exports`/`main`/`types`
// from `publishConfig` to the dist build, converts `workspace:` ranges to
// the sibling versions stamped below, and runs `prepack` (the dist build).
// The only thing this script changes is the version: the plan's version is
// stamped into each package.json before packing and restored afterwards.

const rootDirectory = process.cwd()
const planPath = resolve(rootDirectory, process.argv[2] ?? "build/release-plan.json")
const artifactsDirectory = resolve(
  rootDirectory,
  process.argv[3] ?? "build/release-artifacts",
)
const plan = JSON.parse(await readFile(planPath, "utf8"))

await rm(artifactsDirectory, { recursive: true, force: true })
await mkdir(artifactsDirectory, { recursive: true })

const restores = []
try {
  // Stamp every version before packing anything, so pnpm's workspace:*
  // rewrites in one package see the planned versions of its siblings.
  for (const release of plan) {
    const manifestPath = join(rootDirectory, release.directory, "package.json")
    const original = await readFile(manifestPath, "utf8")
    restores.push({ manifestPath, original })
    const manifest = JSON.parse(original)
    if (manifest.name !== release.name) {
      throw new Error(`${release.directory} is ${manifest.name}, expected ${release.name}`)
    }
    manifest.version = release.version
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  for (const release of plan) {
    execFileSync("pnpm", ["pack", "--out", join(artifactsDirectory, release.tarball)], {
      cwd: join(rootDirectory, release.directory),
      stdio: "inherit",
    })
  }
} finally {
  for (const { manifestPath, original } of restores) {
    await writeFile(manifestPath, original)
  }
}

await cp(planPath, join(artifactsDirectory, "release-plan.json"))
