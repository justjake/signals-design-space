/**
 * Mounts the signals devtools launch button on the cosignals pages. Loaded
 * on demand (see main.tsx) so default loads
 * and the battery never pull the devtools. Attaches the collector to the
 * page's own engine, then renders the launcher into its own React root — the
 * heavy panel itself is code-split and loads only when the button is first
 * clicked.
 *
 * The engine binding is dynamically imported: each `cosignals-devtools/<engine>`
 * entry imports that engine's module, and a page's non-selected engine must
 * never initialize (the shim selector's isolation rule).
 */
import { createRoot } from "react-dom/client"
import { DevtoolsPanelButton } from "cosignals-devtools/button"

export async function mountDevtoolsButton(
  defaultOpen: boolean,
  engine: "cosignals" | "cosignals-arena",
): Promise<void> {
  if (document.getElementById("cosignals-devtools-launcher") !== null) return
  const { collector } =
    engine === "cosignals-arena"
      ? (await import("cosignals-devtools/cosignals-arena")).attachCosignalsArenaDevtools()
      : (await import("cosignals-devtools/cosignals")).attachCosignalsDevtools()
  const host = document.createElement("div")
  host.id = "cosignals-devtools-launcher"
  document.body.appendChild(host)
  createRoot(host).render(
    <DevtoolsPanelButton
      backend={collector}
      defaultCorner="bottom-right"
      defaultOpen={defaultOpen}
    />,
  )
}
