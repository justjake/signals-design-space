/**
 * Shared bootstrap for every engine entry html. Importing '#engine' binds
 * this page's engine (the selector's top-level await) and registers its
 * React bindings — the engine module registers on evaluation, after the
 * selector has already loaded react-dom/client — so by the time this
 * module runs, rendering a root is all that is left to do.
 */
import { createAppRoot } from "./root"
import { App } from "./App"

const container = document.getElementById("root")
if (container === null) {
  throw new Error("react-signals-playground: missing #root container")
}

// Signals devtools. Renders the devtools launch button (a React component
// the devtools package ships); it lazy-loads the panel on first open.
// Dynamically imported so default loads — and the battery — never fetch
// the devtools. ?devtools=1 opens it on load.
if (location.pathname.includes("cosignals")) {
  const engine = location.pathname.includes("cosignals-arena") ? "cosignals-arena" : "cosignals"
  const open = new URLSearchParams(location.search).has("devtools")
  if (open) {
    // ?devtools: attach the collector before the first render (top-level await),
    // so every node and watcher is captured from the start — including watcher
    // component names, which are only read at a hook's first render while the
    // tracer is attached. Gated on the flag so the default load and the battery
    // never pay for tracing.
    const m = await import("./devtools-button")
    await m.mountDevtoolsButton(true, engine)
  } else {
    void import("./devtools-button").then((m) => m.mountDevtoolsButton(false, engine))
  }
}

createAppRoot(container).render(<App />)
