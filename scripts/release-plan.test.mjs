import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createReleasePlan } from "./release-plan.mjs"

async function makeRoot() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "cosignals-release-plan-"))
  for (const directory of ["packages/cosignals", "packages/cosignals-arena", "packages/devtools"]) {
    await mkdir(join(rootDirectory, directory), { recursive: true })
    await writeFile(join(rootDirectory, directory, "package.json"), '{"version":"1.2.3"}\n')
  }
  return rootDirectory
}

test("main publishes a new package version verbatim on latest", async () => {
  const plan = await createReleasePlan({
    eventName: "push",
    branch: "main",
    sha: "0123456789abcdef",
    rootDirectory: await makeRoot(),
    versionExists: async () => false,
  })
  assert.deepEqual(
    plan.map(({ name, version, tag }) => ({ name, version, tag })),
    [
      { name: "cosignals", version: "1.2.3", tag: "latest" },
      { name: "cosignals-arena", version: "1.2.3", tag: "latest" },
      { name: "cosignals-devtools", version: "1.2.3", tag: "latest" },
    ],
  )
})

test("main publishes an existing package version as a commit-specific next", async () => {
  const plan = await createReleasePlan({
    eventName: "push",
    branch: "main",
    sha: "abcdef0123456789",
    rootDirectory: await makeRoot(),
    versionExists: async (name) => name !== "cosignals-arena",
  })
  assert.deepEqual(
    plan.map(({ version, tag }) => ({ version, tag })),
    [
      { version: "1.2.3-next.abcdef0", tag: "next" },
      { version: "1.2.3", tag: "latest" },
      { version: "1.2.3-next.abcdef0", tag: "next" },
    ],
  )
})

test("pull requests use an npm-safe branch prerelease and the experimental tag", async () => {
  const plan = await createReleasePlan({
    eventName: "pull_request",
    branch: "Feature/Ship_it@NOW",
    sha: "fedcba9876543210",
    rootDirectory: await makeRoot(),
    versionExists: async () => {
      throw new Error("pull request planning must not query base versions")
    },
  })
  assert.equal(plan[0].version, "1.2.3-branch-feature-ship-it-now-fedcba9")
  assert.equal(plan[0].tag, "experimental")
})
