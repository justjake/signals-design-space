# Layout v2 (generated from tools/schema.ts — run pnpm gen)

## node record (plane M, stride 8)

main plane: nodes and links interleaved (ids pre-multiplied by 8; record 0 burned)

| offset | name | kind | meaning | owner |
| --- | --- | --- | --- | --- |
| +0 | `FLAGS` | flags | state machine + kind bits | alloc writes; free zeroes |
| +1 | `DEPS` | LinkId | first link of my dependency list; doubles as free-list next for freed node records | link/unlink; free threads |
| +2 | `DEPS_TAIL` | LinkId | last confirmed dependency link (the re-run cursor) | link/purgeDeps |
| +3 | `SUBS` | LinkId | first link of my subscriber list | linkInsert/unlink |
| +4 | `SUBS_TAIL` | LinkId | last subscriber link | linkInsert/unlink |
| +5 | `GEN` | u31 | generation counter, bumped on free; stale disposers no-op | freeNode bumps |
| +6 | `LOG_HEAD` | LogId | atoms: first log record id in plane G (0 = no log). Aliased as OVERLAY_STAMP on non-atoms. | appendLog creates; sweep clears |
| +7 | `LOG_TAIL` | LogId | atoms: last log record id. Aliased as MEMO_KEY on computeds. | appendLog/sweep |

## link record (plane M, stride 8)

main plane: nodes and links interleaved (ids pre-multiplied by 8; record 0 burned)

| offset | name | kind | meaning | owner |
| --- | --- | --- | --- | --- |
| +0 | `VERSION` | u31 | evaluation-cycle stamp: intra-run duplicate-read dedup | link stamps |
| +1 | `DEP` | NodeId | producer node id | linkInsert |
| +2 | `SUB` | NodeId | consumer node id | linkInsert |
| +3 | `PREV_SUB` | LinkId | position in the producer's subscriber list | linkInsert/unlink |
| +4 | `NEXT_SUB` | LinkId | position in the producer's subscriber list | linkInsert/unlink |
| +5 | `PREV_DEP` | LinkId | position in the consumer's dependency list | linkInsert/unlink |
| +6 | `NEXT_DEP` | LinkId | position in the consumer's dependency list; doubles as free-list next for freed link records | linkInsert/unlink; free threads |

## log record (plane G, stride 4)

log plane: write-log entries (ids pre-multiplied by 4; record 0 burned; bulk-reset at quiescence)

| offset | name | kind | meaning | owner |
| --- | --- | --- | --- | --- |
| +0 | `L_NEXT` | LogId | next entry in this atom's log (append order = seq order); 0 = tail; doubles as free-list next | appendLog/sweep; free threads |
| +1 | `L_META` | flags | packed: bits 0-1 OP, bit 2 APPLIED, bit 3 RETIRED, bits 4-8 BATCH_SLOT, bit 9 PSEUDO | appendLog writes; retirement stamps RETIRED |
| +2 | `L_SEQ` | seq | take-a-number ticket at append time | appendLog/coalesce |
| +3 | `L_RETIRED_SEQ` | seq | 0 while the batch is pending; one fresh ticket stamped per retirement | retirement stamps |

## memo record (plane W, stride 8)

world-memo plane: overlay memo records (certificate region lives in a companion array; bulk-reset at quiescence)

| offset | name | kind | meaning | owner |
| --- | --- | --- | --- | --- |
| +0 | `W_KEY` | u31 | world key: newest 0; pass (serial<<2)|1; writer (token<<2)|2 | overlayEvaluate |
| +1 | `W_EPOCH` | u31 | overlayEpoch at evaluation time; 0 is the tombstone value (epochs start at 1) | overlayEvaluate; re-memoization tombstones |
| +2 | `W_NODE` | NodeId | owning computed node id (drain re-validation + stale-head guard) | overlayEvaluate |
| +3 | `W_VAL` | u31 | index into the memoVals side array holding the memoized value | overlayEvaluate; tombstone clears the slot |
| +4 | `W_NEXT_MEMO` | MemoId | next memo record for the same node (the node's memo chain) | overlayEvaluate prepends |
| +5 | `W_SLOT_NEXT` | MemoId | writer's-world records only: next record in the batch slot's memo chain; 0 on other keys | overlayEvaluate; slot release clears heads |
| +6 | `W_NDEPS` | u31 | number of certificate pairs | overlayEvaluate |
| +7 | `W_CERT` | CertOff | offset of this memo's certificate run in the certificate region | overlayEvaluate |

## Flags word

| bit | name | meaning |
| --- | --- | --- |
| 1 | `MUTABLE` | can produce new values (atoms, computeds) |
| 2 | `WATCHING` | wants notification when possibly stale (effects, watchers) |
| 4 | `RECURSED_CHECK` | currently evaluating (re-entrancy guard) |
| 8 | `RECURSED` | re-entrant write reached me during my own run |
| 16 | `DIRTY` | definitely stale |
| 32 | `PENDING` | possibly stale - verify by pulling before recomputing |
| 64 | `HAS_CHILD_EFFECT` | my dep list contains child effects/scopes (slow-path cleanup) |
| 128 | `LOGGED` | atoms only: LOG_HEAD !== 0. The read gate. |
| 256 | `IMMEDIATE` | watchers only: notify synchronously via the broadcast list instead of the effect queue |
| 512 | `LIVE` | RESERVED: superseded by the liveCount side-column refcount (§8.6 conversion); bit kept for layout stability |
| 1024 | `K_ATOM` | kind bit: atom |
| 2048 | `K_COMPUTED` | kind bit: computed |
| 4096 | `K_EFFECT` | kind bit: effect |
| 8192 | `K_SCOPE` | kind bit: effect scope |
| 16384 | `K_WATCHER` | kind bit: watcher (React hook subscription) |
| — | `KIND_MASK` | union of the kind bits; a freed record has FLAGS 0 (K_ATOM \| K_COMPUTED \| K_EFFECT \| K_SCOPE \| K_WATCHER) |

## log META packing

bits 0-1 OP, bit 2 APPLIED, bit 3 RETIRED, bits 4-8 BATCH_SLOT, bit 9 PSEUDO (slot-exhaustion fallback)

| value | name | meaning |
| --- | --- | --- |
| 0 | `OP_BASE` | base record: the snapshot replays start from |
| 1 | `OP_SET` | SET: payload replaces the accumulator |
| 2 | `OP_UPDATE` | UPDATE: stored function applies to the accumulator |
| 3 | `OP_DISPATCH` | DISPATCH: the atom's reducer applies the stored action |
| 3 | `OP_MASK` | mask for the op bits |
| 4 | `M_APPLIED` | already written through the kernel (urgent writes) |
| 8 | `M_RETIRED` | the entry's batch retired |
| 4 | `SLOT_SHIFT` | batch slot starts at bit 4 |
| 31 | `SLOT_MASK` | 5 bits: 32 slots |
| 512 | `M_PSEUDO` | always-included pseudo-batch fallback (degrades toward urgent) |

## read contexts

per-read ambient context (a module scalar, kept correct by fork edges)

| value | name | meaning |
| --- | --- | --- |
| 1 | `CTX_NEWEST` | default: everything visible (Wn) |
| 2 | `CTX_RENDER` | while React executes render code: the pass world (Wp) |
| 3 | `CTX_COMMITTED` | useSignalEffect callbacks and SSR: committed views |

## world kinds

internal world-descriptor discriminants

| value | name | meaning |
| --- | --- | --- |
| 0 | `WK_W0` | the canonical world (committed + applied) the kernel maintains |
| 1 | `WK_NEWEST` | every write visible |
| 2 | `WK_PASS` | a render pass: pin + include mask |
| 3 | `WK_WRITER` | a batch's writer world: retired + applied + own entries |
| 4 | `WK_COMMITTED` | committed views: retired-only, per-root refined by pin + lock-in mask |

## write modes

the §9.1 monotonic gate

| value | name | meaning |
| --- | --- | --- |
| 0 | `MODE_DIRECT` | pure kernel writes (pre-activation, servers) |
| 1 | `MODE_LOGGED` | every write is logged - permanently after first root registration |

## Side columns

| column | index | holds |
| --- | --- | --- |
| `values` | `id >> 2 (+1)` | atom current value / computed cached value; slot 1: atom kernel pending value / effect cleanup |
| `fns` | `id >> 3` | computed kernel wrapper / effect function |
| `memos` | `id >> 3` | node memo-chain head in plane W (guarded by W_NODE, §7.4) |
| `metas` | `id >> 3` | policy metadata object (isEqual, reducer, rawFn, lastBroadcast, observeEffect) |
| `unappliedStamp` | `id >> 3` | era-scoped "unapplied entries below me" walk-ticket stamps (per-cone NEWEST gate) |
| `liveCount` | `id >> 3` | count of LIVE direct subscribers; LIVE(node) := count > 0 || effect/scope/watcher kind (§8.6 refcount) |
| `logVals` | `gid >> 2` | log-entry payload: SET value / UPDATE fn / DISPATCH action / BASE snapshot |
| `memoVals` | `allocated` | world-memo values (undefined for tombstones) |
