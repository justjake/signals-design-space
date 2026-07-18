import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { readReleaseArtifacts } from "./publish-tarballs.mjs"

const ignoredNames = new Set([
  ".git",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
])

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`)
  }
}

function parseArgs(args) {
  const options = {
    artifactsDirectory: "",
    full: false,
    keep: false,
    workDirectory: "",
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--full") {
      options.full = true
    } else if (arg === "--keep") {
      options.keep = true
    } else if (arg === "--work-directory") {
      options.workDirectory = args[++index] ?? ""
      if (options.workDirectory === "") throw new Error("Missing --work-directory value")
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/verify-release-artifacts.mjs <artifacts-directory> [--full] [--keep] [--work-directory <path>]",
      )
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

async function copyPlayground(rootDirectory, workDirectory) {
  const source = join(rootDirectory, "packages/react-signals-playground")
  const destination = join(workDirectory, "packages/react-signals-playground")
  await mkdir(join(workDirectory, "packages"), { recursive: true })
  await cp(source, destination, {
    recursive: true,
    filter: (sourcePath) => !ignoredNames.has(basename(sourcePath)),
  })
  await cp(join(rootDirectory, "tsconfig.base.json"), join(workDirectory, "tsconfig.base.json"))
  return destination
}

export async function verifyReleaseArtifacts({
  artifactsDirectory,
  full,
  keep,
  rootDirectory,
  workDirectory,
}) {
  const releases = await readReleaseArtifacts(artifactsDirectory)
  const temporary = workDirectory === ""
  const consumerRoot = temporary
    ? await mkdtemp(join(tmpdir(), "cosignals-release-consumer-"))
    : resolve(workDirectory)

  if (!temporary) {
    await rm(consumerRoot, { recursive: true, force: true })
    await mkdir(consumerRoot, { recursive: true })
  }

  try {
    const playgroundDirectory = await copyPlayground(rootDirectory, consumerRoot)
    const manifestPath = join(playgroundDirectory, "package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    for (const release of releases) {
      if (manifest.dependencies?.[release.name] === undefined) {
        throw new Error(`Playground has no dependency on ${release.name}`)
      }
      manifest.dependencies[release.name] = `file:${release.tarballPath}`
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile"], {
      cwd: playgroundDirectory,
    })
    run("pnpm", ["check"], { cwd: playgroundDirectory })

    if (full) {
      const installArgs =
        process.platform === "linux"
          ? ["exec", "playwright", "install", "--with-deps", "chromium"]
          : ["exec", "playwright", "install", "chromium"]
      run("pnpm", installArgs, { cwd: playgroundDirectory })
      run("pnpm", ["battery"], {
        cwd: playgroundDirectory,
        env: { ...process.env, CI: "true" },
      })
      run("pnpm", ["devtools-e2e"], {
        cwd: playgroundDirectory,
        env: { ...process.env, CI: "true", DEVTOOLS_E2E_PRODUCTION: "1" },
      })
    }

    console.log(`Verified ${releases.length} packed packages.`)
  } finally {
    if (temporary && !keep) {
      await rm(consumerRoot, { recursive: true, force: true })
    } else {
      console.log(`Release consumer kept at ${consumerRoot}`)
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options === null) return
  const rootDirectory = fileURLToPath(new URL("..", import.meta.url))
  await verifyReleaseArtifacts({
    ...options,
    artifactsDirectory: resolve(options.artifactsDirectory),
    rootDirectory,
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
