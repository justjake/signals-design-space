import { spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { npmVersionExists } from "./npm-registry.mjs"
import { createReleasePlan } from "./release-plan.mjs"
import { verifyReleaseArtifacts } from "./verify-release-artifacts.mjs"

const rootDirectory = fileURLToPath(new URL("..", import.meta.url))

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, {
    cwd: rootDirectory,
    stdio: "inherit",
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`)
  }
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDirectory,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

function usage() {
  console.log(`Usage: pnpm run publish -- [options]

Build, test, pack, verify, and publish the cosignals packages.

Options:
  --dry-run       Run npm publish --dry-run instead of publishing.
  --full          Run the Playwright battery and production devtools tests before packing.
  --allow-dirty   Permit a real publish from a dirty worktree.
  --pack-only     Test, build, and pack into build/release-artifacts.
  --verify-only   Verify the tarballs in build/release-artifacts.
  --publish-only  Publish the tarballs in build/release-artifacts.
  --work-directory  Keep artifact-consumer files in this directory.
  -h, --help      Show this help.`)
}

export function parsePublishArgs(args) {
  const options = {
    allowDirty: false,
    dryRun: false,
    full: false,
    stage: "all",
    workDirectory: "",
  }
  let selectedStage = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--") {
      continue
    } else if (arg === "--allow-dirty") {
      options.allowDirty = true
    } else if (arg === "--work-directory") {
      options.workDirectory = args[++index] ?? ""
      if (options.workDirectory === "") throw new Error("Missing --work-directory value")
    } else if (arg.startsWith("--work-directory=")) {
      options.workDirectory = arg.slice("--work-directory=".length)
    } else if (arg === "--dry-run") {
      options.dryRun = true
    } else if (arg === "--full") {
      options.full = true
    } else if (arg === "--pack-only" || arg === "--verify-only" || arg === "--publish-only") {
      if (selectedStage) throw new Error("Select only one release stage")
      selectedStage = true
      options.stage =
        arg === "--pack-only" ? "pack" : arg === "--verify-only" ? "verify" : "publish"
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

export function releasePaths(directory) {
  const buildDirectory = join(directory, "build")
  return {
    artifactsDirectory: join(buildDirectory, "release-artifacts"),
    buildDirectory,
    planPath: join(buildDirectory, "release-plan.json"),
  }
}

export function assertPublishableWorktree({ allowDirty, dryRun, status }) {
  if (!dryRun && !allowDirty && status !== "") {
    throw new Error(
      "Refusing to publish from a dirty worktree. Commit the changes or pass --allow-dirty.",
    )
  }
}

async function verifyToolchain() {
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error(`Node 24 is required; found ${process.version}`)
  }
  const manifest = JSON.parse(await readFile(join(rootDirectory, "package.json"), "utf8"))
  const expectedPnpm = manifest.devEngines?.packageManager?.version
  const actualPnpm = output("pnpm", ["--version"])
  if (actualPnpm !== expectedPnpm) {
    throw new Error(`pnpm ${expectedPnpm} is required; found ${actualPnpm}`)
  }
}

function installChromium(packageDirectory) {
  const installArgs =
    process.platform === "linux"
      ? ["--dir", packageDirectory, "exec", "playwright", "install", "--with-deps", "chromium"]
      : ["--dir", packageDirectory, "exec", "playwright", "install", "chromium"]
  run("pnpm", installArgs)
}

function verifySource(full) {
  run("pnpm", ["release:test"])

  for (const packageDirectory of ["packages/cosignals", "packages/cosignals-arena"]) {
    run("pnpm", ["--dir", packageDirectory, "typecheck"])
    run("pnpm", ["--dir", packageDirectory, "test"])
    run("pnpm", ["--dir", packageDirectory, "test:react18"])
  }

  run("pnpm", ["--dir", "packages/devtools", "typecheck"])
  run("pnpm", ["--dir", "packages/devtools", "test"])

  if (full) {
    const playgroundDirectory = "packages/react-signals-playground"
    installChromium(playgroundDirectory)
    run("pnpm", ["--dir", playgroundDirectory, "devtools-e2e"])
  }

  for (const packageDirectory of [
    "packages/cosignals",
    "packages/cosignals-arena",
    "packages/devtools",
  ]) {
    run("pnpm", ["--dir", packageDirectory, "build"])
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage()
    return
  }
  const options = parsePublishArgs(process.argv.slice(2))
  await verifyToolchain()

  const publishes = options.stage === "all" || options.stage === "publish"
  if (publishes) {
    if (process.env["CI"] !== "true") {
      assertPublishableWorktree({
        ...options,
        status: output("git", ["status", "--porcelain"]),
      })
      if (!options.dryRun) run("pnpm", ["whoami"])
    }
  }

  const { artifactsDirectory, buildDirectory, planPath } = releasePaths(rootDirectory)

  if (options.stage === "all" || options.stage === "pack") {
    await mkdir(buildDirectory, { recursive: true })
    const plan = await createReleasePlan({
      eventName: process.env["GITHUB_EVENT_NAME"] || "push",
      branch:
        process.env["GITHUB_HEAD_REF"] ||
        process.env["GITHUB_REF_NAME"] ||
        output("git", ["branch", "--show-current"]),
      sha: process.env["GITHUB_SHA"] || output("git", ["rev-parse", "HEAD"]),
      rootDirectory,
      versionExists: npmVersionExists,
    })
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`)

    console.log("Release plan:")
    for (const release of plan) {
      console.log(`  ${release.name}@${release.version} --tag ${release.tag}`)
    }
    console.log(`  source verification: ${options.full ? "full" : "unit tests"}`)
    console.log("")

    verifySource(options.full)
    run("pnpm", ["release:pack", planPath, artifactsDirectory])
  }

  if (options.stage === "all" || options.stage === "verify") {
    await verifyReleaseArtifacts({
      artifactsDirectory,
      full: options.full,
      keep: false,
      rootDirectory,
      workDirectory: options.workDirectory,
    })
  }

  if (publishes) {
    const publishArgs = ["scripts/publish-tarballs.mjs", artifactsDirectory]
    if (options.dryRun) publishArgs.push("--dry-run")
    run("node", publishArgs)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
