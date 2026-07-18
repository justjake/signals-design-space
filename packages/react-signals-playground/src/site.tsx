/**
 * The explainer sections of the site: hero (rendered straight from the
 * engine's own README, so the page can never drift from the docs), a
 * signals primer, primitives with code samples, the transitions intro
 * that frames the lab, and per-engine design notes.
 *
 * Static content only — every live demo lives in App.tsx (the transitions
 * lab), StressField.tsx, and BenchSection.tsx.
 */
import * as React from "react"
import { marked } from "marked"
import { name as engineName } from "#engine"

// Widened on purpose: the engine module's `name` is typed as the literal
// "cosignals" (the selector's surface type), but at runtime it is
// whichever engine this page selected.
const name: string = engineName
import cosignalsReadme from "../../cosignals/README.md?raw"
import arenaReadme from "../../cosignals-arena/README.md?raw"

// The intro is the README's opening section: heading through the content
// before the first h2, plus the reference-link definitions so
// reference-style links resolve. Hand-mirrored copies drift; this cannot.
function readmeIntroHtml(readme: string, heading: string): string {
  const start = readme.indexOf(heading)
  const end = readme.indexOf("\n## ", start)
  const linkDefs = [...readme.matchAll(/^\[[^\]]+\]: \S+$/gm)].map((m) => m[0]).join("\n")
  return marked.parse(readme.slice(start, end < 0 ? undefined : end) + "\n\n" + linkDefs, {
    async: false,
  })
}

const INTRO_HTML =
  name === "cosignals-arena"
    ? readmeIntroHtml(arenaReadme, "# cosignals-arena")
    : readmeIntroHtml(cosignalsReadme, "# cosignals")

export function Hero(): React.ReactElement {
  // The README is this repo's own trusted document, rendered by marked
  // with no user input in the pipeline.
  return (
    <section
      className="prose hero"
      aria-label="introduction"
      dangerouslySetInnerHTML={{ __html: INTRO_HTML }}
    />
  )
}

function Code({ children }: { children: string }): React.ReactElement {
  return (
    <pre className="code">
      <code>{children.trim()}</code>
    </pre>
  )
}

export function WhatAreSignals(): React.ReactElement {
  return (
    <section className="prose" aria-label="what are signals">
      <h2>What are signals?</h2>
      <p>
        Signals form a dependency graph from automatically tracked reads. <em>Atoms</em> hold
        writable values. <em>Computeds</em> derive values. <em>Effects</em> react to changes.
      </p>
      <div className="sigflow" role="img" aria-label="count atom read by doubled computed, read by a document.title effect">
        <span className="signode">atom: count</span>
        <span className="sigarrow">─ read by →</span>
        <span className="signode">computed: doubled</span>
        <span className="sigarrow">─ read by →</span>
        <span className="signode">effect: document.title</span>
      </div>
      <p>
        Writing an atom marks its dependents stale. Computeds update when read, and effects update
        when scheduled. If a computed returns the same value, propagation stops there.
      </p>
    </section>
  )
}

export function Primitives(): React.ReactElement {
  return (
    <section className="prose" aria-label="primitives">
      <h2>The primitives</h2>

      <h3>Atoms</h3>
      <p>
        An atom stores a writable value outside the component tree. Its API resembles{" "}
        <code>useState</code>.
      </p>
      <Code>{`
import { createAtom } from "${name}"

const count = createAtom(1)
count.get() // 1
count.set(2) // replace the value
count.update((n) => n + 1) // write as a function of the previous value
count.get() // 3
`}</Code>
      <p>
        In React, <code>useSignal(count)</code> reads the atom and re-renders the component when it
        changes. The counter below uses this pattern.
      </p>

      <h3>Computeds</h3>
      <p>
        A computed caches a value derived from other signals, much like <code>useMemo</code> or a
        Redux selector. It tracks the signals read by its function.
      </p>
      <Code>{`
import { createComputed } from "${name}"

const doubled = createComputed(() => count.get() * 2)
doubled.get() // 6
count.set(10)
doubled.get() // 20; recomputed because count changed
doubled.get() // 20; cached without running the function again
`}</Code>
      <p>
        Dependencies can change between runs. A signal read only in one branch is tracked only when
        that branch runs. Computeds can also read promises through <code>use</code> and suspend.
      </p>

      <h3>Effects</h3>
      <p>
        An effect reacts to signal changes. <code>watch</code> declares the tracked source, and{" "}
        <code>run</code> performs the untracked side effect. Effects see committed state, so a
        transition reaches them when it commits.
      </p>
      <Code>{`
import { useSignalEffect } from "${name}"

useSignalEffect(
  () => ({
    watch: doubled,
    run: (value) => {
      document.title = \`doubled is \${value}\`
    },
  }),
  [],
)
`}</Code>
      <p>
        Outside React, use <code>createEffect(watch, run)</code> with the same two-part shape.
      </p>
    </section>
  )
}

export function TransitionsIntro(): React.ReactElement {
  return (
    <section className="prose" aria-label="transitions">
      <h2>Transitions with external state</h2>
      <p>
        React transitions prepare the next screen while the current screen stays interactive. The
        visible tree keeps its old state until the transition can commit.
      </p>
      <p>
        React can do this with <code>useState</code> because each render chooses which queued
        updates to apply. Most external stores expose one current value. They cannot show a pending
        value to the transition without also exposing it to the current screen. <code>{name}</code>{" "}
        keeps those views separate.
      </p>
      <ul>
        <li>Writes inside a transition go into a draft.</li>
        <li>The current screen, ordinary reads, and effects keep reading committed state.</li>
        <li>The transition reads committed state with its draft applied.</li>
        <li>On commit, the draft becomes the atom's current value.</li>
      </ul>
      <p>
        The lab below runs each navigation inside <code>startSignalTransition</code>. The
        destination suspends until its fake request finishes. Choose <em>hold</em>, navigate, then
        use the counter, clock, or filter. The timeline marks urgent commits that finish while the
        navigation remains pending. The consistency tile reports if one committed render mixes
        values from different states.
      </p>
    </section>
  )
}

export function StressIntro(): React.ReactElement {
  return (
    <section className="prose" aria-label="stress test intro">
      <h2>Signal graph stress test</h2>
      <p>
        Each pixel is a signal or computed with an effect that repaints it. Deep bands contain
        64-level dependency chains. Wide bands connect a few source signals to thousands of
        subscribers. The wave updates about 10% of the graph per frame. Draw with the left mouse
        button and erase with the right.
      </p>
      <p>
        Every library runs the same graph through the adapters from the reactivity benchmark.
      </p>
    </section>
  )
}

export function BenchIntro(): React.ReactElement {
  return (
    <section className="prose" aria-label="benchmarks intro">
      <h2>Benchmarks</h2>
      <p>
        The{" "}
        <a href="https://github.com/justjake/js-reactivity-benchmark">
          justjake/js-reactivity-benchmark
        </a>{" "}
        suites run in this tab. Each suite and library pair gets a fresh worker to isolate module
        state and JIT feedback. These single-round results are useful for local comparisons. The
        package READMEs link to CI results from three interleaved rounds.
      </p>
    </section>
  )
}

export function EngineNotes(): React.ReactElement {
  return (
    <section className="prose" aria-label="engine notes">
      <h2>Two builds, one API</h2>
      {name === "cosignals-arena" ? (
        <>
          <p>
            <strong>cosignals-arena</strong> stores nodes and dependency edges as fixed-size records
            in a shared <code>Int32Array</code>. Records refer to each other by numeric id. Graph
            traversal uses contiguous memory and allocates fewer JavaScript objects.
          </p>
          <p>
            Its public API matches cosignals, so both pages run the same application. The tradeoff
            is a fixed-capacity arena and more complex memory management. Start with cosignals
            unless profiling shows that graph traversal is a bottleneck.
          </p>
        </>
      ) : (
        <>
          <p>
            <strong>cosignals</strong> stores its graph in linked JavaScript objects. Start here if
            you want to read, debug, or extend the implementation.
          </p>
          <p>
            <strong>cosignals-arena</strong> has the same API and semantics, but stores the graph in
            fixed-capacity typed-array records. It may run faster and is harder to modify. Use the
            tabs above to run this page on either engine.
          </p>
        </>
      )}
      <p>
        The button in the bottom-right corner opens the cosignals devtools for the active engine.
      </p>
    </section>
  )
}
