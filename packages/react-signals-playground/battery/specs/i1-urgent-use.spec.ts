/**
 * FIND-URGENT-USE: urgent-lane React.use(pendingPromise) in a real browser.
 *
 * The research repro (research/urgent-use-repro) showed the "retry never
 * fires" wedge is an act()-harness artifact: a non-awaited synchronous act
 * scope strands the root's scheduler task, identically on pristine upstream
 * React (SPEC-RESOLUTIONS item 12; upstream regression test
 * ReactDOMUseUrgentActStall-test.js). No act exists in a browser, so this
 * row pins the working browser behavior — an urgent suspension resolves and
 * the retry ping paints the content — guarding the fork's retry path.
 */
import { expect, test } from "../fixtures"
import { applyExpectation } from "../expectations"
import { clockTicks, gotoApp } from "../helpers"

test("FIND-URGENT-USE: urgent React.use suspension retries and paints on resolve", async ({
  page,
  entry,
}) => {
  applyExpectation(test, "FIND-URGENT-USE", entry)
  await gotoApp(page, entry)
  await expect(page.getByTestId("use-probe")).toHaveText("idle")

  // Arm on the urgent lane: the epoch write is a plain (non-transition)
  // write, so the suspension lands urgently and its boundary shows the
  // fallback (no transition to hold the old content).
  await page.evaluate(() => window.__store.armUseProbe())
  await expect(page.getByTestId("use-probe-fallback")).toBeVisible()
  expect(await clockTicks(page), "page froze on an urgent suspension").toBe(true)

  // Settlement must ping the retry: content replaces the fallback.
  await page.evaluate(() => window.__store.settleUseProbe())
  await expect(page.getByTestId("use-probe")).toHaveText("settled")
  await expect(page.getByTestId("use-probe-fallback")).toHaveCount(0)
})
