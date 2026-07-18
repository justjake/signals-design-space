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
// the devtools package ships); the button attaches the tracer only while
// recording and lazy-loads the panel on first open, so a default load pays
// nothing for tracing. Dynamically imported so the battery never fetches
// the devtools at all. ?devtools=1 opens the panel and starts recording.
if (location.pathname.includes("cosignals")) {
  const engine = location.pathname.includes("cosignals-arena") ? "cosignals-arena" : "cosignals"
  const open = new URLSearchParams(location.search).has("devtools")
  if (open) {
    // ?devtools: mount (and start recording) before the first render — the
    // top-level await plus the mount's flushSync guarantee it — so every node
    // and watcher is captured from the start, including watcher component
    // names, which are only read at a hook's first render while recording.
    const m = await import("./devtools-button")
    await m.mountDevtoolsButton(true, engine)
  } else {
    void import("./devtools-button").then((m) => m.mountDevtoolsButton(false, engine))
  }
}

createAppRoot(container).render(<App />)
