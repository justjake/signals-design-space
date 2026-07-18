/**
 * Mounts the signals devtools launch button on the cosignals pages. Loaded
 * on demand (see main.tsx) so default loads and the battery never pull the
 * devtools. The button owns the whole devtools lifecycle: it builds the
 * collector from the `create` factory on first need and attaches the trace
 * hooks only while recording, so a page where nobody touches the button pays
 * nothing for tracing. The heavy panel is code-split behind the first open.
 *
 * The engine binding is dynamically imported: each `cosignals-devtools/<engine>`
 * entry imports that engine's module, and a page's non-selected engine must
 * never initialize (the engine selector's isolation rule).
 */
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { DevtoolsPanelButton } from "cosignals-devtools/button"

export async function mountDevtoolsButton(
  defaultOpen: boolean,
  engine: "cosignals" | "cosignals-arena",
): Promise<void> {
  if (document.getElementById("cosignals-devtools-launcher") !== null) return
  const create =
    engine === "cosignals-arena"
      ? (await import("cosignals-devtools/cosignals-arena")).createCosignalsArenaDevtools
      : (await import("cosignals-devtools/cosignals")).createCosignalsDevtools
  const host = document.createElement("div")
  host.id = "cosignals-devtools-launcher"
  document.body.appendChild(host)
  // flushSync so the button's mount effects run before this resolves: on the
  // ?devtools path (defaultOpen) the caller awaits this and then renders the
  // app, and recording must already be attached to capture the first render's
  // nodes and watcher component names.
  const root = createRoot(host)
  flushSync(() => {
    root.render(
      <DevtoolsPanelButton
        create={create}
        defaultCorner="bottom-right"
        defaultOpen={defaultOpen}
        defaultRecording={defaultOpen}
      />,
    )
  })
}
