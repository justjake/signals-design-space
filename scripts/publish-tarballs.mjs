import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { npmVersionExists } from "./npm-registry.mjs"

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`)
  }
}

function readTarballManifest(tarballPath) {
  const result = spawnSync("tar", ["-xOf", tarballPath, "package/package.json"], {
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`Unable to read package/package.json from ${tarballPath}:\n${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

export async function readReleaseArtifacts(artifactsDirectory) {
  const directory = resolve(artifactsDirectory)
  const plan = JSON.parse(await readFile(join(directory, "release-plan.json"), "utf8"))
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error("release-plan.json must contain at least one package")
  }

  return plan.map((release) => {
    if (
      typeof release.name !== "string" ||
      typeof release.version !== "string" ||
      typeof release.tag !== "string" ||
      typeof release.tarball !== "string"
    ) {
      throw new Error("release-plan.json contains an invalid package entry")
    }
    if (basename(release.tarball) !== release.tarball) {
      throw new Error(`Invalid tarball filename: ${release.tarball}`)
    }

    const tarballPath = join(directory, release.tarball)
    const manifest = readTarballManifest(tarballPath)
    if (manifest.name !== release.name || manifest.version !== release.version) {
      throw new Error(
        `${release.tarball} contains ${manifest.name}@${manifest.version}, expected ${release.name}@${release.version}`,
      )
    }
    return { ...release, tarballPath }
  })
}

export async function publishPlannedArtifacts({
  dryRun,
  releases,
  versionExists,
  publishTarball,
}) {
  for (const release of releases) {
    if (!dryRun && (await versionExists(release.name, release.version))) {
      console.log(`${release.name}@${release.version} already exists; skipping immutable version`)
      continue
    }
    await publishTarball(release, dryRun)
  }
}

export function npmPublishInvocation(release, dryRun) {
  const args = [
    "publish",
    release.tarballPath,
    "--tag",
    release.tag,
    "--access",
    "public",
  ]
  if (dryRun) args.push("--dry-run")
  return { args, cwd: dirname(release.tarballPath) }
}

function parseArgs(args) {
  const options = { artifactsDirectory: "", dryRun: false }
  for (const arg of args) {
    if (arg === "--dry-run") {
      options.dryRun = true
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/publish-tarballs.mjs <artifacts-directory> [--dry-run]")
      return null
    } else if (options.artifactsDirectory === "") {
      options.artifactsDirectory = arg
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (options.artifactsDirectory === "") throw new Error("Missing artifacts directory")
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options === null) return

  const releases = await readReleaseArtifacts(options.artifactsDirectory)
  await publishPlannedArtifacts({
    dryRun: options.dryRun,
    releases,
    versionExists: npmVersionExists,
    publishTarball: async (release, dryRun) => {
      console.log(`${dryRun ? "Checking" : "Publishing"} ${release.name}@${release.version}`)
      const invocation = npmPublishInvocation(release, dryRun)
      run("npm", invocation.args, { cwd: invocation.cwd })
    },
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
