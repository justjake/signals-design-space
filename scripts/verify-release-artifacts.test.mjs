import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import * as verifier from "./verify-release-artifacts.mjs"

test("release verification copies the dedicated consumer", async () => {
  assert.equal(typeof verifier.copyReleaseConsumer, "function")

  const rootDirectory = await mkdtemp(join(tmpdir(), "cosignals-release-root-"))
  const consumerSource = join(rootDirectory, "scripts/release-consumer")
  const destination = join(rootDirectory, "build/consumer")
  await mkdir(consumerSource, { recursive: true })
  await writeFile(join(consumerSource, "marker.txt"), "packed artifact consumer\n")

  await verifier.copyReleaseConsumer(rootDirectory, destination)

  assert.equal(
    await readFile(join(destination, "marker.txt"), "utf8"),
    "packed artifact consumer\n",
  )
})
