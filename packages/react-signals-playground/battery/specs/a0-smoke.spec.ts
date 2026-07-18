/**
 * Meta/smoke rows: page identity, holdStyle table verification, engine
 * isolation, clean registration, and baseline liveness. Everything else in
 * the battery assumes these hold.
 */
import { ENTRIES } from "../entries"
import { expect, test } from "../fixtures"
import { clockTicks, gotoApp, testidText } from "../helpers"

test("META-REDIRECT: root redirects temporarily to the default implementation", async ({
  request,
}) => {
  const response = await request.get("/", { maxRedirects: 0 })
  expect(response.status()).toBe(302)
  expect(response.headers().location).toBe("/cosignals/")
})

test("META-IDENT: impl-name tile matches the entry; exactly one active tab", async ({
  page,
  entry,
}) => {
  await gotoApp(page, entry)
  const activeTabs = await page.locator(".tabbar a.on").allTextContents()
  expect(activeTabs).toEqual([entry.label])
})

test("META-HOLDSTYLE: the page-declared holdStyle matches the battery entry table", async ({
  page,
  entry,
}) => {
  await gotoApp(page, entry)
  const runtime = await page.evaluate(() => ({
    name: window.__store.name,
    holdStyle: window.__store.holdStyle,
  }))
  expect(runtime).toEqual({ name: entry.name, holdStyle: entry.holdStyle })
})

test("META-ISOLATION: only the selected implementation chunk is requested (chunk isolation pin)", async ({
  page,
  entry,
}) => {
  const requested: string[] = []
  page.on("request", (request) => requested.push(request.url()))
  await gotoApp(page, entry)

  // An engine chunk URL: dev serves /src/engine/<id>.ts, the build emits assets/<id>-<hash>.js.
  const chunkOf = (label: string): RegExp =>
    new RegExp(`/engine/${label}\\.ts$|/assets/${label}-[^/]*\\.js$`)
  expect(
    requested.some((url) => chunkOf(entry.label).test(url)),
    `no chunk for ${entry.label} in ${requested.filter((u) => /assets|engine/.test(u)).join(", ")}`,
  ).toBe(true)
  const others = ENTRIES.map((e) => e.label).filter((label) => label !== entry.label)
  for (const other of others) {
    // Labels can prefix one another (cosignals / cosignals-arena), and a
    // built chunk is named label-hash, so a prefix label's matcher also hits
    // the longer label's chunk: discount whatever is this page's own chunk.
    const loaded = requested.filter(
      (url) => chunkOf(other).test(url) && !chunkOf(entry.label).test(url),
    )
    expect(loaded, `foreign implementation chunk loaded: ${other}`).toEqual([])
  }
})

test("META-REGISTER: registration exclusivity — clean boot, root rendered, zero errors", async ({
  page,
  entry,
}) => {
  // The error-budget fixture asserts zero console/page errors at teardown;
  // this test's body proves the positive half: the engine registered and
  // the root actually rendered its committed UI.
  await gotoApp(page, entry)
  await expect(page.getByTestId("view-panel")).toHaveAttribute("data-view", "dashboard")
  expect(await testidText(page, "pending")).toBe("no")
})

test("META-CLOCK: the urgent clock ticks at rest and committed renders advance", async ({
  page,
  entry,
}) => {
  await gotoApp(page, entry)
  expect(await clockTicks(page), "clock frozen at rest").toBe(true)
  const toggle = page.locator("#stat-clock button")
  await toggle.click()
  const pausedAt = await testidText(page, "clock")
  await page.waitForTimeout(250)
  expect(await testidText(page, "clock"), "clock advanced while paused").toBe(pausedAt)
  await expect(toggle).toHaveText("resume")
  await toggle.click()
  expect(await clockTicks(page), "clock did not resume").toBe(true)
  // The clock deliberately never feeds the committed-render tally (app
  // design: the test cadence would drown the interaction signal), so drive a
  // tallied component — the controls strip — to see the tally move.
  const before = Number(await testidText(page, "renders-committed"))
  await page.getByTestId("increment").click()
  await expect(page.getByTestId("count")).toHaveText("1")
  const after = Number(await testidText(page, "renders-committed"))
  expect(after, "renders-committed tally frozen across an urgent commit").toBeGreaterThan(before)
})
