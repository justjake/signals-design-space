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
        <em>Signals</em> are a state management system made up of <em>atoms</em>,{" "}
        <em>computeds</em>, and <em>effects</em>, which form a graph of automatically-tracked
        dependency relationships:
      </p>
      <div className="sigflow" role="img" aria-label="count atom read by doubled computed, read by a document.title effect">
        <span className="signode">atom: count</span>
        <span className="sigarrow">─ read by →</span>
        <span className="signode">computed: doubled</span>
        <span className="sigarrow">─ read by →</span>
        <span className="signode">effect: document.title</span>
      </div>
      <p>
        A write to an atom <em>pushes invalidation</em>: it marks downstream work as possibly stale
        and schedules effects for revalidation. When a computed is read or a scheduled effect
        revalidates, it <em>pulls</em> values from its upstream signals. If all upstream computeds
        recompute to equal values, the update stops. If the computed or effect's inputs change,
        then they re-run.
      </p>
    </section>
  )
}

export function Primitives(): React.ReactElement {
  return (
    <section className="prose" aria-label="primitives">
      <h2>The primitives</h2>

      <h3>Atoms — writable values</h3>
      <p>
        An <strong>atom</strong> stores a value you can change over time. It is like{" "}
        <code>useState</code>, but it lives outside any component:
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
        In React, <code>useSignal(count)</code> reads the atom and subscribes, so the component
        re-renders when the value changes — that is the whole wiring. The counter in the lab below
        is exactly this pattern.
      </p>

      <h3>Computeds — derived values</h3>
      <p>
        A <strong>computed</strong> derives a cached value from other signals, like{" "}
        <code>useMemo</code> or a Redux selector. The signals its function reads become its
        dependencies automatically, and it recomputes only when read after a dependency changed:
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
        Dependencies are dynamic: a branch not taken during an evaluation is not a dependency. A
        computed can also read promises through its <code>use</code> argument and suspend like a
        React component — see the async section of the README.
      </p>

      <h3>Effects — reactions</h3>
      <p>
        An <strong>effect</strong> runs a side effect when signals change, like{" "}
        <code>useEffect</code>. Effects have two parts: <code>watch</code>, the tracked source, and{" "}
        <code>run</code>, the untracked side effect. Effects observe committed state — a pending
        transition reaches every effect exactly once, when it commits:
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
        <code>createEffect(watch, run)</code> is the same shape for effects owned outside the
        component tree — module scope, stores, or non-React code.
      </p>
    </section>
  )
}

export function TransitionsIntro(): React.ReactElement {
  return (
    <section className="prose" aria-label="transitions">
      <h2>Transitions: the part external stores can't do</h2>
      <p>
        React transitions let React prepare the next screen in the background while the current one
        stays interactive: updates inside <code>startTransition</code> render in low-priority
        passes, and the visible tree keeps showing the old state until the new tree is ready to
        commit.
      </p>
      <p>
        This works for <code>useState</code> because React keeps pending updates in per-hook
        queues, and each render pass chooses which updates to apply. A typical external store
        cannot participate: it has one current value, so it must either expose a transition's
        write immediately (the current screen flashes half-finished state) or hide it from the
        background render (the transition renders stale data). <code>{name}</code> gives atoms the
        same machinery React gives its own state:
      </p>
      <ul>
        <li>
          a write made inside a transition is recorded in a draft attached to that transition,
          leaving the atom unchanged;
        </li>
        <li>the committed screen, ordinary reads, and effects keep seeing the value without the draft;</li>
        <li>the transition's own render passes see the value with the draft applied;</li>
        <li>
          when the transition commits, the draft folds into the atom and every ordinary reader sees
          the change once.
        </li>
      </ul>
      <p>
        The lab below is that machinery under load. It is a tiny browser: every navigation runs
        inside <code>startSignalTransition</code> and suspends on a fake fetch until the
        destination's data arrives. Set nav latency to <em>hold</em>, navigate, and then poke the
        urgent controls — the counter, clock, and filter keep committing while the navigation
        stays pending, and the timeline strip records every urgent commit that landed inside the
        pending window. The consistency tile cross-checks reads in every committed frame; it has
        never said TORN on either engine, and the Playwright battery pins that.
      </p>
    </section>
  )
}

export function StressIntro(): React.ReactElement {
  return (
    <section className="prose" aria-label="stress test intro">
      <h2>Stress test: a signal graph you can see</h2>
      <p>
        Every pixel below is a signal or a computed, plus a render effect that repaints it when its
        value changes. The field alternates bands of two shapes chosen to stress opposite ends of a
        reactivity system: <em>deep</em> bands are 64-level chains one pixel wide (long serial
        re-validation), and <em>wide</em> bands fan a few hub signals out to thousands of
        subscribers (broad shallow invalidation). A wave driver writes about 10% of the graph per
        frame, and you can draw on the canvas — left button paints, right button erases.
      </p>
      <p>
        The same field builds against any library on the roster through the reactivity benchmark's
        own adapters, so the comparison is the scheduler and propagation engine, not the demo code.
      </p>
    </section>
  )
}

export function BenchIntro(): React.ReactElement {
  return (
    <section className="prose" aria-label="benchmarks intro">
      <h2>Benchmarks, in this tab</h2>
      <p>
        The{" "}
        <a href="https://github.com/justjake/js-reactivity-benchmark">
          justjake/js-reactivity-benchmark
        </a>{" "}
        suites, run right here: each (suite, library) cell gets a fresh worker realm so no library
        inherits JIT feedback or main-thread work from another. One round on your machine is
        indicative, not a scoreboard — the README's CI charts run interleaved rounds and report
        medians.
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
            You are on <strong>cosignals-arena</strong>, the data-oriented build. Every node and
            dependency edge is a fixed-size record inside one shared <code>Int32Array</code>; a
            "reference" between records is a numeric id, not an object pointer. The hot paths —
            invalidation waves, cache validation, effect drains — walk integers through contiguous
            memory instead of chasing pointers through the heap: better cache locality, fewer
            allocations, less garbage-collector pressure.
          </p>
          <p>
            The public handles stay ordinary objects, so the API is identical to cosignals — this
            whole page runs unchanged on either engine. The costs: the engine manages its own
            memory (a record pool, free lists, reclamation), and the record arena has a fixed
            capacity. If you are unsure which to use, start with cosignals and reach for the arena
            when profiling says the graph itself is hot.
          </p>
        </>
      ) : (
        <>
          <p>
            You are on <strong>cosignals</strong>, the reference build: the reactive graph lives in
            linked JavaScript objects, the way you would write it by hand. It is the one to read,
            debug, and start with.
          </p>
          <p>
            <strong>cosignals-arena</strong> (switchable top-right) is the data-oriented build:
            same public API, same semantics, same test suite, but the graph lives in fixed-capacity
            typed-array records and the hot paths walk numeric ids through contiguous memory. This
            may improve speed but makes the implementation harder to understand. Every demo on
            this page behaves identically there — which is the point.
          </p>
        </>
      )}
      <p>
        Both pages ship the cosignals devtools: the button in the bottom-right corner opens a live
        view of the signal graph, effect runs, and render causality for the engine driving this
        page.
      </p>
    </section>
  )
}
