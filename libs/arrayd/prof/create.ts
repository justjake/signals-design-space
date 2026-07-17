/** Creation-cost profile: signals + 1-dep effects, arrayd vs alien. */
import * as arrayd from "../src/index"
// eslint-disable-next-line import/no-relative-packages
import * as alien from "../../../upstream-alien-signals/src/index"

const lib: typeof arrayd = (process.env.ALIEN ? (alien as unknown) : arrayd) as typeof arrayd
const { signal, effect, effectScope } = lib

const N = 200_000
const holder: unknown[] = new Array(N)

// warmup + measure signals
for (let round = 0; round < 6; round++) {
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    holder[i] = signal(i)
  }
  const t1 = performance.now()
  if (round >= 4) {
    console.log(`signals x${N}: ${(t1 - t0).toFixed(2)} ms`)
  }
}

// effects reading 1 signal each, inside a scope
const sigs = holder as (() => number)[]
for (let round = 0; round < 6; round++) {
  const t0 = performance.now()
  const dispose = effectScope(() => {
    for (let i = 0; i < N; i++) {
      const s = sigs[i]
      effect(() => {
        s()
      })
    }
  })
  const t1 = performance.now()
  dispose()
  const t2 = performance.now()
  if (round >= 4) {
    console.log(`effects x${N}: ${(t1 - t0).toFixed(2)} ms; dispose: ${(t2 - t1).toFixed(2)} ms`)
  }
}
