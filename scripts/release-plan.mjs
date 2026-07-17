import { readFile, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const packages = [
  { directory: "packages/cosignals", name: "cosignals" },
  { directory: "packages/cosignals-arena", name: "cosignals-arena" },
  { directory: "packages/devtools", name: "cosignals-devtools" },
]

export async function createReleasePlan({ eventName, branch, sha, rootDirectory, versionExists }) {
  if (eventName !== "push" && eventName !== "pull_request") {
    throw new Error(`Unsupported release event: ${eventName}`)
  }

  const shortSha = sha.slice(0, 7).toLowerCase()
  if (!/^[0-9a-f]{7}$/.test(shortSha)) {
    throw new Error(`Expected a Git commit SHA, received: ${sha}`)
  }

  let releaseBranch = ""
  if (eventName === "pull_request") {
    releaseBranch = branch
      .toLowerCase()
      .replace(/[^0-9a-z-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48)
      .replace(/-$/g, "")
    if (releaseBranch === "") throw new Error(`Branch has no npm-safe characters: ${branch}`)
  }

  const plan = []
  for (const releasePackage of packages) {
    const manifest = JSON.parse(
      await readFile(
        new URL(`${releasePackage.directory}/package.json`, pathToFileURL(`${rootDirectory}/`)),
        "utf8",
      ),
    )
    const baseVersion = manifest.version
    let version = baseVersion
    let tag = "latest"

    if (eventName === "push") {
      if (await versionExists(releasePackage.name, baseVersion)) {
        version = `${baseVersion}-next.${shortSha}`
        tag = "next"
      }
    } else {
      version = `${baseVersion}-branch-${releaseBranch}-${shortSha}`
      tag = "experimental"
    }

    plan.push({
      directory: releasePackage.directory,
      name: releasePackage.name,
      baseVersion,
      version,
      tag,
      tarball: `${releasePackage.name}-${version}.tgz`,
    })
  }
  return plan
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDirectory = process.cwd()
  const output = process.argv[2] ?? "release-plan.json"
  const plan = await createReleasePlan({
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "",
    sha: process.env.GITHUB_SHA ?? "",
    rootDirectory,
    versionExists: async (name, version) => {
      const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
      )
      if (response.status === 404) return false
      if (!response.ok)
        throw new Error(`npm registry returned ${response.status} for ${name}@${version}`)
      return true
    },
  })
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`)
  for (const release of plan) console.log(`${release.name}@${release.version} --tag ${release.tag}`)
}
