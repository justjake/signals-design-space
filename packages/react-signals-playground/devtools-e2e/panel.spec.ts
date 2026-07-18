import { expect, test } from "@playwright/test"

// Panel smoke + canvas gestures, ported from the old devtools-package demo e2e
// so deleting that demo loses no coverage. Drives the real playground app with
// the panel open (?devtools) on both engine pages.

for (const page_ of [
  { path: "/cosignals/?devtools", engine: "cosignals" },
  { path: "/cosignals-arena/?devtools", engine: "cosignals-arena" },
] as const) {
  test(`panel shows the live ${page_.engine} graph + log and updates on interaction`, async ({
    page,
  }) => {
    await page.goto(page_.path)
    const panel = page.locator(".signals-devtools-root")
    await expect(panel).toBeVisible()

    // Graph is the default tab: nodes are discovered, listed, inspectable.
    // `doubled` is a computed, registered at load (its compute is traced);
    // `count` is an atom that only appears once written, so assert on doubled.
    await expect(panel.getByRole("button", { name: "Graph", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    )
    await expect(panel).toContainText("doubled")
    await panel.locator(".nodelist tbody tr").filter({ hasText: "doubled" }).first().click()
    await expect(panel).toContainText("Value")
    await expect(panel).toContainText("Upstream")
    await expect(panel).toContainText("Downstream")

    // Log tab: real entries with verbatim kind strings (computes at load).
    await panel.getByRole("button", { name: "Log", exact: true }).click()
    await expect(panel).toContainText("compute")
    const rowsBefore = await panel.locator(".log tbody tr").count()

    // A +1 urgent write produces new activity the panel captures.
    await page.getByTestId("increment").click()
    await expect
      .poll(async () => panel.locator(".log tbody tr").count())
      .toBeGreaterThan(rowsBefore)
  })
}

test("graph trackpad gestures keep the pinch focal point fixed and scroll to pan", async ({
  page,
}) => {
  await page.goto("/cosignals/?devtools")
  await expect(page.locator(".signals-devtools-root")).toBeVisible()
  const svg = page.locator(".canvas-wrap svg")
  await expect(svg).toBeVisible()

  const result = await svg.evaluate((element) => {
    const graph = element as SVGSVGElement
    const box = graph.getBoundingClientRect()
    const clientX = Math.round(box.left + box.width * 0.3)
    const clientY = Math.round(box.top + box.height * 0.4)
    const pointAtGesture = () => {
      const matrix = graph.getScreenCTM()
      if (matrix === null) throw new Error("SVG has no screen transform")
      const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
      return { x: point.x, y: point.y }
    }
    const viewBox = () => graph.viewBox.baseVal
    return new Promise<{
      before: { point: { x: number; y: number }; width: number }
      afterPinch: {
        point: { x: number; y: number }
        x: number
        y: number
        width: number
        height: number
      }
      afterPan: { x: number; y: number; width: number; height: number }
    }>((resolve) => {
      // React applies the zoom/pan state asynchronously, so a fixed number
      // of animation frames races the commit on a loaded machine. Poll the
      // viewBox until the gesture's effect is visible (bounded), then move on.
      const waitFor = (done: () => boolean, next: () => void, deadline: number) => {
        const check = () => {
          if (done() || performance.now() > deadline) {
            next()
          } else {
            requestAnimationFrame(check)
          }
        }
        requestAnimationFrame(check)
      }
      const before = { point: pointAtGesture(), width: viewBox().width }
      // ctrl+wheel = trackpad pinch (zoom in).
      graph.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -40,
          ctrlKey: true,
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        }),
      )
      waitFor(
        () => viewBox().width !== before.width,
        () => {
          const afterPinch = {
            point: pointAtGesture(),
            x: viewBox().x,
            y: viewBox().y,
            width: viewBox().width,
            height: viewBox().height,
          }
          // plain wheel = pan.
          graph.dispatchEvent(
            new WheelEvent("wheel", { deltaX: 12, deltaY: 18, bubbles: true, cancelable: true }),
          )
          waitFor(
            () => viewBox().x !== afterPinch.x && viewBox().y !== afterPinch.y,
            () => {
              resolve({
                before,
                afterPinch,
                afterPan: {
                  x: viewBox().x,
                  y: viewBox().y,
                  width: viewBox().width,
                  height: viewBox().height,
                },
              })
            },
            performance.now() + 5000,
          )
        },
        performance.now() + 5000,
      )
    })
  })

  expect(result.afterPinch.width).toBeLessThan(result.before.width) // pinch zoomed in
  expect(result.afterPinch.point.x).toBeCloseTo(result.before.point.x, 4) // focal point fixed
  expect(result.afterPinch.point.y).toBeCloseTo(result.before.point.y, 4)
  expect(result.afterPan.width).toBeCloseTo(result.afterPinch.width, 6) // pan doesn't zoom
  expect(result.afterPan.x).toBeGreaterThan(result.afterPinch.x) // scrolled to pan
  expect(result.afterPan.y).toBeGreaterThan(result.afterPinch.y)
})

test("double-click a collapsible log row toggles collapse", async ({ page }) => {
  await page.goto("/cosignals/?devtools")
  const panel = page.locator(".signals-devtools-root")
  await expect(panel).toBeVisible()
  await panel.locator(".nodelist tbody tr").first().waitFor()
  // A few writes give the tree collapsible root operations (depth-0 with children).
  for (let i = 0; i < 5; i++) await page.getByTestId("increment").click()
  await panel.getByRole("button", { name: "Log", exact: true }).click()

  // Select a collapsible root first: the collector prepends new operations, so rows
  // reorder under us — .selected then pins that row by identity as it moves.
  await panel.locator(".log tbody tr.op-head").first().locator(".chip").click()
  const selected = panel.locator(".log tbody tr.selected")
  await expect(selected.locator(".caret")).toHaveText("▾") // expanded by default
  await page.waitForTimeout(600) // let the double-click window lapse so the next pair is clean

  // Two clicks within the window collapse it; another pair expands it again.
  await selected.locator(".chip").click()
  await selected.locator(".chip").click()
  await expect(selected.locator(".caret")).toHaveText("▸")
  await page.waitForTimeout(600)
  await selected.locator(".chip").click()
  await selected.locator(".chip").click()
  await expect(selected.locator(".caret")).toHaveText("▾")
})

test("following an in-log cause link scrolls the target into view", async ({ page }) => {
  await page.goto("/cosignals/?devtools")
  const panel = page.locator(".signals-devtools-root")
  await expect(panel).toBeVisible()
  await panel.locator(".nodelist tbody tr").first().waitFor()
  for (let i = 0; i < 6; i++) await page.getByTestId("increment").click()
  await panel.getByRole("button", { name: "Log", exact: true }).click()
  await expect(panel.locator(".log tbody button.causeref").first()).toBeVisible()

  // Scroll the log fully down so an earlier cause target is off-screen, then
  // follow the bottom-most cause link — its target must land inside the viewport.
  await panel.locator(".log").evaluate((el) => {
    let p = el as HTMLElement | null
    while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement
    if (p) p.scrollTop = p.scrollHeight
  })
  await panel.locator(".log tbody button.causeref").last().click()
  const selected = panel.locator(".log tbody tr.selected")
  await expect(selected).toHaveCount(1)
  await expect(async () => {
    const inView = await selected.first().evaluate((el) => {
      const cr = el.getBoundingClientRect()
      const sc = (el as HTMLElement).closest(".signals-devtools-root")!.getBoundingClientRect()
      return cr.top >= sc.top - 1 && cr.bottom <= sc.bottom + 1
    })
    expect(inView).toBe(true)
  }).toPass()
})
