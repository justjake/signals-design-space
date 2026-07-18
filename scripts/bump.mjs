import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const packageDirectories = ["packages/cosignals", "packages/cosignals-arena", "packages/devtools"]
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export async function bumpPackages(rootDirectory, requestedVersion) {
  if (requestedVersion === undefined) {
    throw new Error("Usage: pnpm run bump <version|patch|minor|major>")
  }

  const increment =
    requestedVersion === "patch" || requestedVersion === "minor" || requestedVersion === "major"
  if (!increment && !semverPattern.test(requestedVersion)) {
    throw new Error(`Invalid version: ${requestedVersion}`)
  }

  const manifests = []
  for (const directory of packageDirectories) {
    const path = join(rootDirectory, directory, "package.json")
    const manifest = JSON.parse(await readFile(path, "utf8"))
    let version = requestedVersion

    if (increment) {
      const match = semverPattern.exec(manifest.version)
      if (match === null) throw new Error(`Invalid current version in ${path}: ${manifest.version}`)

      let major = Number(match[1])
      let minor = Number(match[2])
      let patch = Number(match[3])
      const prerelease = match[4] !== undefined

      if (requestedVersion === "major") {
        if (minor !== 0 || patch !== 0 || !prerelease) major++
        minor = 0
        patch = 0
      } else if (requestedVersion === "minor") {
        if (patch !== 0 || !prerelease) minor++
        patch = 0
      } else if (!prerelease) {
        patch++
      }
      version = `${major}.${minor}.${patch}`
    }

    manifest.version = version
    manifests.push({ path, manifest })
  }

  for (const { path, manifest } of manifests) {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`${manifest.name}@${manifest.version}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bumpPackages(process.cwd(), process.argv[2])
}
