import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import test from "node:test"
import {
  assertPublishableWorktree,
  parsePublishArgs,
  releasePaths,
} from "./publish-release.mjs"
import { pnpmPublishInvocation, publishPlannedArtifacts } from "./publish-tarballs.mjs"

test("publish arguments default to a real, lightweight release", () => {
  assert.deepEqual(parsePublishArgs([]), {
    allowDirty: false,
    dryRun: false,
    full: false,
    stage: "all",
    workDirectory: "",
  })
})

test("publish arguments enable independent safety and verification options", () => {
  assert.deepEqual(parsePublishArgs(["--", "--dry-run", "--full", "--allow-dirty"]), {
    allowDirty: true,
    dryRun: true,
    full: true,
    stage: "all",
    workDirectory: "",
  })
  assert.throws(() => parsePublishArgs(["--skip-tests"]), /Unknown argument/)
})

test("CI stages share the publish driver", () => {
  assert.deepEqual(parsePublishArgs(["--pack-only"]), {
    allowDirty: false,
    dryRun: false,
    full: false,
    stage: "pack",
    workDirectory: "",
  })
  assert.deepEqual(
    parsePublishArgs([
      "--verify-only",
      "--full",
      "--work-directory",
      "/tmp/release-consumer",
    ]),
    {
      allowDirty: false,
      dryRun: false,
      full: true,
      stage: "verify",
      workDirectory: "/tmp/release-consumer",
    },
  )
  assert.deepEqual(parsePublishArgs(["--publish-only"]), {
    allowDirty: false,
    dryRun: false,
    full: false,
    stage: "publish",
    workDirectory: "",
  })
  assert.throws(
    () => parsePublishArgs(["--pack-only", "--verify-only"]),
    /only one release stage/,
  )
})

test("release plans and tarballs stay under the ignored build directory", () => {
  assert.deepEqual(releasePaths("/repo"), {
    artifactsDirectory: "/repo/build/release-artifacts",
    buildDirectory: "/repo/build",
    planPath: "/repo/build/release-plan.json",
  })
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

test("pnpm publishes outside the workspace", () => {
  assert.deepEqual(
    pnpmPublishInvocation(
      {
        name: "cosignals",
        version: "1.2.3",
        tag: "next",
        tarballPath: "/tmp/release-artifacts/cosignals-1.2.3.tgz",
      },
      true,
    ),
    {
      command: "pnpm",
      args: [
        "publish",
        "/tmp/release-artifacts/cosignals-1.2.3.tgz",
        "--tag",
        "next",
        "--access",
        "public",
        "--no-git-checks",
        "--dry-run",
      ],
      cwd: tmpdir(),
    },
  )
})
