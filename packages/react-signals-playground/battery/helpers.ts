/**
 * Shared page-driving helpers, promoted from the exploratory lab scripts
 * that first drove this app. The surviving patterns:
 *
 * - MutationObserver transient capture (`armTornWatch`, `armTextTrace`):
 *   commits can be replaced faster than polling sees them, so a page-side
 *   observer records every committed text the DOM ever showed.
 * - Instant-of-commit snapshots (`snapshotWhen`): a waitForFunction whose
 *   predicate returns the whole snapshot object at the moment its condition
 *   first holds, so assertions read state captured in that exact frame.
 * - One-commit-boundary tolerance (`settleNav`): tiles written by
 *   committed-world effects (the duration tile) may land one commit after
 *   the navigation itself; settle waits for both.
 * - Wedge watchdogs (`withWatchdog`): anything that may block the main
 *   thread races a timer; on timeout the main thread's live stack is
 *   captured over CDP (Debugger.pause) and attached to the report before
 *   the scenario decides what a hang means for its implementation.
 *
 * All helpers assume the page was opened with `gotoApp` (?test=1), which the
 * app's testkit reads to install `window.__store` and the test panel.
 */
import type { Page, TestInfo } from "@playwright/test"
import { expect } from "./fixtures"
import type { BatteryEntry } from "./entries"
import type { TestStore } from "../src/testkit"

declare global {
  interface Window {
    __store: TestStore
    __torn: number[]
    __trace: Record<string, string[]>
  }
}

// ---- navigation and identity ---------------------------------------------------------

/** Open the entry's page in test mode and prove identity before any scenario runs. */
export async function gotoApp(
  page: Page,
  entry: BatteryEntry,
  options?: { query?: Record<string, string> },
): Promise<void> {
  const params = new URLSearchParams({ test: "1", ...options?.query })
  await page.goto(`${entry.path}?${params.toString()}`)
  await expect(page.getByTestId("impl-name")).toHaveText(entry.name)
}

/** The app's own testid text, trimmed. */
export async function testidText(page: Page, testid: string): Promise<string> {
  return ((await page.getByTestId(testid).first().textContent()) ?? "").trim()
}

// ---- store access (window.__store, testkit-installed) --------------------------------

/** Outside-render read of a labeled signal — a foreign (evaluate) call stack, the RT4 posture. */
export function storeRead(page: Page, label: string): Promise<unknown> {
  return page.evaluate((l) => window.__store.read(l), label)
}

/** Urgent write to a labeled atom from a foreign call stack. */
export function storeWrite(page: Page, label: string, value: unknown): Promise<void> {
  return page.evaluate(([l, v]) => window.__store.write(l, v), [label, value] as const)
}

// ---- clocks and liveness --------------------------------------------------------------

/** True when the 100 ms test-mode clock advances within `withinMs`. */
export async function clockTicks(page: Page, withinMs = 2000): Promise<boolean> {
  const before = await testidText(page, "clock")
  return page
    .waitForFunction(
      (prev) => document.querySelector('[data-testid="clock"]')?.textContent?.trim() !== prev,
      before,
      { timeout: withinMs },
    )
    .then(() => true)
    .catch(() => false)
}

export interface RafHealth {
  /** requestAnimationFrame callbacks observed per second; a wedged main thread scores 0. */
  framesPerSec: number
  /** Committed-render tally drift over the window. */
  rendersDelta: number
}

/**
 * Main-thread health over a `windowMs` observation window; `null` when the
 * page cannot even run the probe (fully blocked main thread).
 */
export async function rafHealth(page: Page, windowMs = 1000): Promise<RafHealth | null> {
  const probe = page.evaluate(
    (ms) =>
      new Promise<RafHealth>((resolve) => {
        const start = performance.now()
        let frames = 0
        const rendersBefore = Number(
          document.querySelector('[data-testid="renders-committed"]')?.textContent ?? "0",
        )
        function frame(): void {
          frames += 1
          if (performance.now() - start < ms) {
            requestAnimationFrame(frame)
          } else {
            resolve({
              framesPerSec: Math.round(frames / (ms / 1000)),
              rendersDelta:
                Number(
                  document.querySelector('[data-testid="renders-committed"]')?.textContent ?? "0",
                ) - rendersBefore,
            })
          }
        }
        requestAnimationFrame(frame)
      }),
    windowMs,
  )
  return Promise.race([
    probe,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), windowMs + 3000)),
  ])
}

// ---- transient DOM capture -----------------------------------------------------------

/** Record every flip of the consistency verdict to TORN (transients included). */
export async function armTornWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__torn = []
    const el = document.querySelector('[data-testid="consistency"]')
    if (el === null) {
      throw new Error("armTornWatch: no consistency tile")
    }
    new MutationObserver(() => {
      if (el.textContent === "TORN") {
        window.__torn.push(performance.now())
      }
    }).observe(el, { characterData: true, subtree: true, childList: true })
  })
}

/** TORN flips observed since armTornWatch, including ones later overwritten. */
export function tornFlips(page: Page): Promise<number> {
  return page.evaluate(() => window.__torn.length)
}

/** Record every committed text of a testid element (transients included). */
export async function armTextTrace(page: Page, testid: string): Promise<void> {
  await page.evaluate((tid) => {
    window.__trace ??= {}
    const el = document.querySelector(`[data-testid="${tid}"]`)
    if (el === null) {
      throw new Error(`armTextTrace: no element for testid ${tid}`)
    }
    const log: string[] = []
    window.__trace[tid] = log
    log.push(el.textContent ?? "")
    new MutationObserver(() => log.push(el.textContent ?? "")).observe(el, {
      characterData: true,
      subtree: true,
      childList: true,
    })
  }, testid)
}

export function readTextTrace(page: Page, testid: string): Promise<string[]> {
  return page.evaluate((tid) => window.__trace[tid] ?? [], testid)
}

// ---- instant-of-commit snapshots ------------------------------------------------------

/**
 * Wait until `pageFn` returns non-null and resolve with that value: the
 * snapshot is taken inside the page at the first moment the condition
 * holds, not after a round-trip. Returns null on timeout.
 */
export async function snapshotWhen<Arg, T>(
  page: Page,
  pageFn: (arg: Arg) => T | null,
  arg: Arg,
  timeoutMs = 10_000,
): Promise<T | null> {
  try {
    // The cast bridges Playwright's Unboxed<Arg> plumbing; every caller
    // passes a JSON-serializable arg, which is the actual requirement.
    const handle = await page.waitForFunction(
      pageFn as Parameters<Page["waitForFunction"]>[0],
      arg,
      { timeout: timeoutMs },
    )
    return (await handle.jsonValue()) as T
  } catch {
    return null
  }
}

// ---- app-level navigation shapes -------------------------------------------------------

export type RouteName = "dashboard" | "table" | "detail"

/** Engage latency=hold and navigate; resolves once the pending window is open. */
export async function holdNavigate(page: Page, route: RouteName): Promise<void> {
  await page.getByTestId("latency-hold").click()
  await page.getByTestId(`view-tab-${route}`).click()
  await expect(page.getByTestId("pending")).toHaveText("yes")
}

/**
 * Wait for a navigation to `route` to fully settle: committed view flipped,
 * pending flag down, and the effect-written duration tile populated (it may
 * land one commit boundary after the navigation itself — tolerated, not raced).
 */
export async function settleNav(page: Page, route: RouteName, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    (r) =>
      document.querySelector<HTMLElement>('[data-testid="view-panel"]')?.dataset.view === r &&
      document.querySelector('[data-testid="pending"]')?.textContent === "no" &&
      /\d+ ms/.test(document.querySelector('[data-testid="last-nav-ms"]')?.textContent ?? ""),
    route,
    { timeout: timeoutMs },
  )
}

/** Release a held navigation and wait for it to settle on `route`. */
export async function releaseAndSettle(page: Page, route: RouteName): Promise<void> {
  await page.getByTestId("release").click()
  await settleNav(page, route)
}

// ---- wedge watchdogs -------------------------------------------------------------------

export interface WatchdogOutcome<T> {
  wedged: boolean
  /** Present when the action completed in time. */
  value?: T
  /** Main-thread stack captured at the moment of the hang. */
  stack?: readonly string[]
}

/**
 * Race `action` against a watchdog. The CDP debugger is armed BEFORE the
 * action runs — Debugger.enable never completes once the main thread is
 * already spinning, so arming afterward would hang the capture itself. On
 * timeout, Debugger.pause interrupts V8 wherever it is, the live stack is
 * attached to the report, and the verdict goes back to the scenario — which
 * decides whether a wedge is a failure or the expected finding.
 */
export async function withWatchdog<T>(
  page: Page,
  testInfo: TestInfo,
  label: string,
  timeoutMs: number,
  action: () => Promise<T>,
): Promise<WatchdogOutcome<T>> {
  const cdp = await page.context().newCDPSession(page)
  const paused = new Promise<string[]>((resolve) => {
    cdp.on("Debugger.paused", (event) =>
      resolve(
        event.callFrames.map(
          (frame) =>
            `${frame.functionName || "(anonymous)"} @ ${frame.url
              .split("/")
              .slice(-2)
              .join("/")}:${frame.location.lineNumber + 1}`,
        ),
      ),
    )
  })
  await cdp.send("Debugger.enable")
  try {
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    })
    const raced = await Promise.race([action().then((value) => ({ value })), timedOut])
    clearTimeout(timer)
    if (raced !== "timeout") {
      return { wedged: false, value: raced.value }
    }

    await cdp.send("Debugger.pause").catch(() => {})
    const stack = await Promise.race([
      paused,
      new Promise<string[]>((resolve) =>
        setTimeout(() => resolve(["<no pause within 5s — main thread appears idle>"]), 5000),
      ),
    ])
    await cdp.send("Debugger.resume").catch(() => {})
    await testInfo.attach(`${label}-wedge-stack`, {
      body: stack.join("\n"),
      contentType: "text/plain",
    })
    return { wedged: true, stack }
  } finally {
    // A wedged renderer never acks the detach; don't let cleanup hang the
    // test on it.
    await Promise.race([
      cdp.detach().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ])
  }
}

/** Evaluate-returns-promptly probe: false means the main thread is blocked. */
export async function mainThreadResponsive(page: Page, timeoutMs = 3000): Promise<boolean> {
  return Promise.race([
    page.evaluate(() => 0).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
}

/**
 * Set an input's value the way a real keystroke would (native setter +
 * input event), from inside the page: Playwright's fill() would block on
 * actionability if the write wedges the main thread, so wedge-prone writes
 * dispatch page-side and let the caller watchdog the result.
 */
export function dispatchFilterInput(page: Page, value: string): Promise<void> {
  return page.evaluate((v) => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="filter-input"]')
    if (input === null) {
      throw new Error("dispatchFilterInput: no filter input")
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, v)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }, value)
}
