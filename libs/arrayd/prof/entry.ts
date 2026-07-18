/**
 * Profiling entry: replicates kairo broadPropagation + avoidablePropagation
 * inner loops against @lab/arrayd (or upstream alien-signals with ALIEN=1)
 * so `node --prof` / --cpu-prof can attribute self time. Not part of the
 * library; dev tool only.
 */
import * as arrayd from "../src/index"
// eslint-disable-next-line import/no-relative-packages
import * as alien from "../../../vendor/alien-signals/src/index"

const lib: typeof arrayd = (process.env.ALIEN ? (alien as unknown) : arrayd) as typeof arrayd

const { signal, computed, effect, effectScope, startBatch, endBatch } = lib

function busy() {
  let a = 0
  for (let i = 0; i < 100; i++) {
    a++
  }
  return a
}

// --- broadPropagation ---
function buildBroad() {
  const head = signal(0)
  let last: () => number = head
  const counter = { count: 0 }
  for (let i = 0; i < 50; i++) {
    const current = computed(() => head() + i)
    const current2 = computed(() => current() + 1)
    effect(() => {
      current2()
      counter.count++
    })
    last = current2
  }
  return () => {
    for (let i = 0; i < 50; i++) {
      startBatch()
      head(i)
      endBatch()
      if (last() !== i + 50) {
        throw new Error("broad wrong")
      }
    }
  }
}

// --- avoidablePropagation ---
function buildAvoidable() {
  const head = signal(0)
  const c1 = computed(() => head())
  const c2 = computed(() => (c1(), 0))
  const c3 = computed(() => (busy(), c2() + 1))
  const c4 = computed(() => c3() + 2)
  const c5 = computed(() => c4() + 3)
  effect(() => {
    c5()
    busy()
  })
  return () => {
    for (let i = 0; i < 1000; i++) {
      startBatch()
      head(i)
      endBatch()
      if (c5() !== 6) {
        throw new Error("avoidable wrong")
      }
    }
  }
}

const which = process.env.SHAPE ?? "broad"
let iter!: () => void
const dispose = effectScope(() => {
  iter = which === "broad" ? buildBroad() : buildAvoidable()
})

// warmup
for (let i = 0; i < 100; i++) {
  iter()
}

const t0 = performance.now()
const N = which === "broad" ? 2000 : 1500
for (let i = 0; i < N; i++) {
  iter()
}
const t1 = performance.now()
console.log(`${which} x${N}: ${(t1 - t0).toFixed(2)} ms`)
dispose()
