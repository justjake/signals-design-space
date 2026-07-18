# The final unit: one notification channel + watermark validation

Two changes built and verified as one unit. Change A removes
`useSyncExternalStore` and routes every React wake through the hook's own
reducer; Change B removes the per-edge/per-node value versions and validates
by clock readings. They compose: the commit-time repair Change A needs
compares the readings Change B introduces.

## A. One notification channel

### What useSyncExternalStore did, and what replaces it

uSES provided three things beyond a subscription:

1. **Forced-sync rendering of store changes.** Not a feature here — it is
   the reason uSES-based stores flatten React's priority system. Replaced
   by nothing, deliberately: a wake is a reducer dispatch in the write's
   own context, so re-renders get exactly `useState`'s lanes (the owner's
   ruling: "it should behave like useState"). One indicator is exempt by
   the same logic React itself uses: `useIsPending`'s flip dispatches
   OUTSIDE any ambient transition (`dispatchUrgent`), mirroring
   `useTransition`, whose isPending update is scheduled before the transition —
   an indicator must not be held by the transition it indicates.
2. **The commit-time snapshot compare** ("did the store move between my
   render and my subscription attaching?"). Replaced by the extended
   commit-time repair in `correctSubscription`: the hook stashes what it
   rendered; at attach, the resolution is re-compared (`resolutionDiffers`)
   and a `REPAIR_WAKE` dispatched if the store moved. Hydration is this
   same gap at its widest — the first commit — and needs no extra
   machinery.
3. **The mid-render consistency check** (yielded renders reading a moving
   store). Replaced by React's own interleaved-update handling: base writes
   are now dispatches React can see, so a write landing while a transition
   render is parked schedules work that commits first, and React restarts
   the in-progress transition against fresh state. Coverage argument by
   cases, for {sync, default, flushSync} writes × {held transition render,
   default render}: default renders never yield, and writes are synchronous
   JS, so no write can interleave a non-yielding render — only transition
   renders park, and every parked-transition case reduces to
   restart-on-interleaved-update, which the dispatch-visible write
   guarantees. The remaining seam — a subscriber whose subscription has not
   attached yet — is case 2.

### The notify predicate targets the COMMITTED tree

The engine's render-notify delivery says "something over your sources
moved"; the hook re-renders only if `resolutionDiffers(node, committed)` —
resolving in the world the committed tree shows, compared against the value
it shows. The committed stash is copied from the render in a layout effect,
so it advances exactly at commits. Targeting the committed tree (not the
latest render) is load-bearing three ways:

- **Fold silence is exact.** A carrier's committed world resolves the
  folded value it already shows → equal → no dispatch. A root that never
  carried the draft resolves news → repair. Per-subscriber comparison
  replaced the global suppression flag, `retireDraft`'s silent option, and
  `confirmRootCommit`'s loudness decision — all deleted.
- **A held pass's speculation stays in the draft channel.** A late append
  to a draft the hook carries changes the PASS's resolution, not the
  committed tree's; the draft channel re-dispatches the id (in the owning
  transition's lanes) and the repair channel correctly stays quiet.
- **Discard costs nothing extra.** The committed tree never showed the
  draft; its pending reducer update renders base state when it lands.

Async parity in the predicate mirrors the unwrap rule: errors are always
news; a suspension with settled history wakes only if its stale value
differs from what is shown; a never-settled suspension is always news.

### Dedup

One `REPAIR_WAKE` per render window (`repairPending`, cleared each render),
same discipline as the draft channel's delivered-set: a pending dispatch
already guarantees a re-render against current state, and over-clearing
only permits a redundant dispatch.

## B. Watermark validation

`node.version`/`link.version` (per-record change counters) are replaced by
one reading per node: `changedAtGraphChange` — the `graphChangeClock`
reading at the node's last REAL value change. Validation is
`dep.changedAtGraphChange > sub.validAtGraphChange` (strictly greater:
equal readings mean that very validation consumed the change). Links carry
no validation state at all; watchers gained `validAtGraphChange` for their
run/validation watermark.

### The named ordering invariants (each enforced with a comment at its site)

1. **Tick-then-stamp** (`writeCell`, `invalidateDerived`): the clock ticks
   first; the change is stamped with the new reading. A pre-tick stamp
   could compare equal to a subscriber that validated before the write.
2. **Real computed changes only** (`recompute`): equality-cutoff
   recomputes do not advance `changedAt`. Atom writes always retain their
   new reading, including writes later reverted in the same batch; moving
   that reading backwards is unsound after an intermediate computed read.
3. **Freshen-then-stamp** (`ensureFresh`; at landing time also the watcher
   validation loop, deleted when effects split into compute + handler — see
   docs/effects.md): a dep is freshened before its reading is compared (a
   lazy dep recomputes mid-walk, stamping with the current clock), and the
   consumer's `validAt` is stamped only after every dep was freshened and
   compared.

### The one place edge stamps were smarter

Old edge stamps updated at read time, so a promote that ran mid-evaluation
saw freshly re-read deps as current. The watermark predates the running
evaluation, so promote now SKIPS history validation on `Computing` nodes —
the running eval is the validator; its finally stamps fresh staleness and a
current reading. (Found by test T12; the fix is the `validate` guard in
`addObserver`.)

## What was deleted

`useSyncExternalStore` (both uses), `storeVersion` + its brand + three
constructor inits + wave/write bump sites, `storeVersionSuppressed`,
`withSuppressedStoreVersion`, `bumpStoreVersionLoud`, `retireDraft`'s
`silent` option, `confirmRootCommit`'s `foldReachedEveryScope` loudness
decision, `NodeVersion` + `node.version` + `link.version` and every
compare/stamp site. The counter taxonomy at landing time: two clocks
(`graphChangeClock`, `draftChangeClock`), readings (`changedAt<Clock>`,
`validAt<Clock>`), two pass identities (`evalPass`, `pokePass`). A later
round merged the clocks: one `graphChangeClock` ticks for base writes,
settlement, and draft activity alike, with a `baseChangedAtGraphChange`
watermark reading distinguishing base changes where a consumer needs the
narrower question (the single-draft write cutoff).

## Probes and falsification

- Lane discriminator (falsified pre-change: `expected '1' to be '0'`): a
  timeout-origin write must NOT render in the microtask window (uSES
  rendered it there); a click-origin write must.
- Mixed atomicity: signal write + setState in one async callback = one
  render (guard).
- Write burst from one callback = one render (guard).
- Render→attach gap: a layout-effect write between render and subscription
  is repaired at attach, exactly one extra render (guard; uSES covered it
  via snapshot compare, the repair covers it now).
- Watermark ordering pins: lazy-chain freshen order, cutoff no-recompute,
  net-revert no-recompute (guards; the invariants they pin were preserved
  from the version discipline).
- The 1200-seed oracle ran twice, deterministic-green, as the semantic
  referee for the validation rewrite; the oracle's subscriber model mirrors
  the notify predicate (resolve in the sub's world, compare against its
  view) instead of a store snapshot.

## SSR note

Server rendering works (`CosignalsProvider` is a `useReducer`
component; its layout effect is client-only). Hydration consistency is the
standard signals-SSR seeding concern — give the client engine the values
the server rendered — and the post-hydration gap is case 2 above.
`getServerSnapshot` machinery is not needed and has no analog here.
