import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { bumpPackages } from "./bump.mjs"

const packageDirectories = ["packages/cosignals", "packages/cosignals-arena", "packages/devtools"]

async function makeRoot(version = "1.2.3") {
  const rootDirectory = await mkdtemp(join(tmpdir(), "cosignals-bump-"))
  for (const directory of packageDirectories) {
    await mkdir(join(rootDirectory, directory), { recursive: true })
    await writeFile(
      join(rootDirectory, directory, "package.json"),
      `${JSON.stringify({ name: directory.split("/").at(-1), version }, null, 2)}\n`,
    )
  }
  return rootDirectory
}

async function versions(rootDirectory) {
  const result = []
  for (const directory of packageDirectories) {
    const manifest = JSON.parse(await readFile(join(rootDirectory, directory, "package.json"), "utf8"))
    result.push(manifest.version)
  }
  return result
}

test("sets an exact semantic version", async () => {
  const rootDirectory = await makeRoot()
  await bumpPackages(rootDirectory, "2.0.0-beta.1+sha.abc")
  assert.deepEqual(await versions(rootDirectory), [
    "2.0.0-beta.1+sha.abc",
    "2.0.0-beta.1+sha.abc",
    "2.0.0-beta.1+sha.abc",
  ])
})

for (const [increment, expected] of [
  ["patch", "1.2.4"],
  ["minor", "1.3.0"],
  ["major", "2.0.0"],
]) {
  test(`increments the ${increment} version`, async () => {
    const rootDirectory = await makeRoot()
    await bumpPackages(rootDirectory, increment)
    assert.deepEqual(await versions(rootDirectory), [expected, expected, expected])
  })
}

test("rejects invalid versions before writing", async () => {
  const rootDirectory = await makeRoot()
  await assert.rejects(bumpPackages(rootDirectory, "1.2"), /Invalid version/)
  assert.deepEqual(await versions(rootDirectory), ["1.2.3", "1.2.3", "1.2.3"])
})
