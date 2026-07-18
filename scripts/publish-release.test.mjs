import assert from "node:assert/strict"
import test from "node:test"
import { assertPublishableWorktree, parsePublishArgs } from "./publish-release.mjs"
import { npmPublishInvocation, publishPlannedArtifacts } from "./publish-tarballs.mjs"

test("publish arguments default to a real, lightweight release", () => {
  assert.deepEqual(parsePublishArgs([]), {
    allowDirty: false,
    artifactsDirectory: "",
    dryRun: false,
    full: false,
    stage: "all",
    workDirectory: "",
  })
})

test("publish arguments enable independent safety and verification options", () => {
  assert.deepEqual(parsePublishArgs(["--", "--dry-run", "--full", "--allow-dirty"]), {
    allowDirty: true,
    artifactsDirectory: "",
    dryRun: true,
    full: true,
    stage: "all",
    workDirectory: "",
  })
  assert.throws(() => parsePublishArgs(["--skip-tests"]), /Unknown argument/)
})

test("CI stages share the publish driver and require an artifact directory", () => {
  assert.deepEqual(parsePublishArgs(["--pack-only", "--artifacts", "release-artifacts"]), {
    allowDirty: false,
    artifactsDirectory: "release-artifacts",
    dryRun: false,
    full: false,
    stage: "pack",
    workDirectory: "",
  })
  assert.deepEqual(
    parsePublishArgs([
      "--verify-only",
      "--artifacts=release-artifacts",
      "--full",
      "--work-directory",
      "/tmp/release-consumer",
    ]),
    {
      allowDirty: false,
      artifactsDirectory: "release-artifacts",
      dryRun: false,
      full: true,
      stage: "verify",
      workDirectory: "/tmp/release-consumer",
    },
  )
  assert.deepEqual(parsePublishArgs(["--publish-only", "--artifacts", "release-artifacts"]), {
    allowDirty: false,
    artifactsDirectory: "release-artifacts",
    dryRun: false,
    full: false,
    stage: "publish",
    workDirectory: "",
  })
  assert.throws(() => parsePublishArgs(["--pack-only"]), /--artifacts/)
  assert.throws(
    () => parsePublishArgs(["--pack-only", "--verify-only", "--artifacts", "out"]),
    /only one release stage/,
  )
})

test("real publishes require a clean worktree unless explicitly allowed", () => {
  assert.doesNotThrow(() =>
    assertPublishableWorktree({ allowDirty: false, dryRun: false, status: "" }),
  )
  assert.doesNotThrow(() =>
    assertPublishableWorktree({ allowDirty: false, dryRun: true, status: " M package.json" }),
  )
  assert.doesNotThrow(() =>
    assertPublishableWorktree({ allowDirty: true, dryRun: false, status: " M package.json" }),
  )
  assert.throws(
    () => assertPublishableWorktree({ allowDirty: false, dryRun: false, status: " M package.json" }),
    /dirty worktree/,
  )
})

test("artifact publishing preserves plan order and skips existing immutable versions", async () => {
  const releases = [
    { name: "cosignals", version: "1.2.3", tag: "latest", tarballPath: "/tmp/core.tgz" },
    { name: "cosignals-arena", version: "1.2.3", tag: "latest", tarballPath: "/tmp/arena.tgz" },
    {
      name: "cosignals-devtools",
      version: "1.2.3",
      tag: "latest",
      tarballPath: "/tmp/devtools.tgz",
    },
  ]
  const published = []

  await publishPlannedArtifacts({
    dryRun: false,
    releases,
    versionExists: async (name) => name === "cosignals-arena",
    publishTarball: async (release) => published.push(release.name),
  })

  assert.deepEqual(published, ["cosignals", "cosignals-devtools"])
})

test("dry runs check every tarball even when its version exists", async () => {
  const releases = [
    { name: "cosignals", version: "1.2.3", tag: "latest", tarballPath: "/tmp/core.tgz" },
  ]
  const published = []

  await publishPlannedArtifacts({
    dryRun: true,
    releases,
    versionExists: async () => true,
    publishTarball: async (release) => published.push(release.name),
  })

  assert.deepEqual(published, ["cosignals"])
})

test("npm publishes from the artifact directory instead of the pnpm workspace", () => {
  assert.deepEqual(
    npmPublishInvocation(
      {
        name: "cosignals",
        version: "1.2.3",
        tag: "next",
        tarballPath: "/tmp/release-artifacts/cosignals-1.2.3.tgz",
      },
      true,
    ),
    {
      args: [
        "publish",
        "/tmp/release-artifacts/cosignals-1.2.3.tgz",
        "--tag",
        "next",
        "--access",
        "public",
        "--dry-run",
      ],
      cwd: "/tmp/release-artifacts",
    },
  )
})
