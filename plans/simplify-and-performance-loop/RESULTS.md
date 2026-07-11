# Loop results

One durable row per completed round. Working raw evidence lives in
`/tmp/fx2-simplify-loop/<round>/` until the result is committed.

| Round | Base SHA | Change/concept removed | Focused performance | Verdict/lesson |
| --- | --- | --- | --- | --- |
| 01 | `1831581a9c6a515b5553d6bcc3a9f325e024964e` | Rejected `liveDrafts` + `Draft.cells` recipient selection; no production change retained | History-heavy median 44.618 -> 1.263 ms (-97.2%); 1,000 unrelated drafts 2.762 -> 44.748 ms (16.2x regression) | `REJECT`: replaced O(cell history) with O(all live drafts); avoiding both requires mirrored membership state or a dual-path policy |
| 02 | `31e1bbdd6cf7e0076e77f9bf061f80671b14796c` | Deleted unread `WorldState.rev`; fused live-ID filtering and membership detection; removed stale revision prose | Repeated-live-ID median 116.497 -> 84.403 ms (-27.6%); final controller median 85.025 ms (-27.0%) | `APPROVE` / `APPROVE`: `ids` is the payload, fresh wrapper identity prevents the render-time bailout; full final gate passed |
| 03 | `4c0e842d47f876ef3d0c2bc2e1036ee5e92a385d` | Rejected per-cell rebase-log selection for `draftsAffecting`; no production change retained | Sparse median 203.796 -> 5.869 ms (-97.1%); retained-history control 3.356 -> 365.891 ms (109.0x regression) | `REJECT`: traded global live-draft scale for unbounded retained intent history; a robust repair requires the forbidden index or hybrid policy |
| 04 | `65aaaf04c3d787ad02f904be5ed081d3cfb2e6ac` | Reused the stable `Draft.world` for the sole live draft; removed per-read single-draft world reconstruction | Single-draft `latest()` median 64.977 -> 29.518 ms (-54.6%); controller 29.653 ms (-54.4%); dual control remained parity | `APPROVE` / `APPROVE`: one owner now serves cutoff and ambient latest reads; full final gate passed |
| 05 | `5a100ee9091675f470558e34e35b5c359d9b62d6` | Fused multi-draft world construction into one presized `liveDrafts` traversal; removed spread, callback allocation, and the second `Draft[]` traversal | Controller constructor medians improved 9.0%/3.6%/2.6% at 2/32/1,024 drafts; end-to-end public `latest()` medians improved 64.0%/19.1%/3.3% | `APPROVE` / `APPROVE`: one canonical traversal fills the replay records and flat memo-key buffer; both frozen probes and the full final gate passed |

## Near-miss ledger

Measured performance improvements that failed the review bar, including
discarded intermediate revisions from an ultimately accepted round. Ultra
carries these forward as evidence; the implementer decides whether a clearer
design can reuse the mechanism.

| Round | Measured benefit | Why rejected | Reusable mechanism | Bar for reuse |
| --- | --- | --- | --- | --- |
| 01 | History-heavy equality-cutoff median 44.618 -> 1.263 ms in controller reproduction (-97.2%) | Adversarial control proved a 16.2x regression when unrelated live drafts dominate; a robust repair added state or dual algorithms | Select recipients from existing `liveDrafts` plus `Draft.cells` only if the selection can remain cell-local | Retry only with a cell-local design that adds no mirrored index or hybrid policy, passes both frozen probes, and directly pins exact multi-draft recipients |
| 02 | Repeated-live-ID reducer median 116.497 -> 84.403 ms (-27.6%); controller medians 83.794 and 84.674 ms (-28.1% and -27.3%) | `REVISE` pass 1: the record attributed `useState`'s eager bailout to `useReducer`; pass 2: `host.ts` still called `REPAIR_WAKE` a revision bump after deleting the revision | Delete unread `WorldState.rev` and fuse live-ID filtering with membership detection in one direct loop | Preserve stable `ids` identity and a fresh wrapper per reducer call; distinguish dispatch scheduling from render-time bailout prevention and remove stale revision-counter prose from production comments |
| 03 | Two relevant among 1,002 live drafts median 203.796 -> 5.869 ms (-97.1%) | A live leading draft pins later same-cell urgent intents; scanning the canonical rebase log made a 20,001-intent control regress 3.356 -> 365.891 ms (109.0x) | Cell-local affected-draft discovery from existing state, but only if lookup does not scan retained intent history | Retry only with no mirrored index or hybrid selector and a representation that makes live membership bounded; pass the single, dense, sparse-unrelated, and 20,001-intent history controls |
| 05 | Constructor-only medians improved 34.0% at 2 drafts, 9.7% at 32, and 7.1% at 1,024 | Incremental signature concatenation deferred flatten/hash work past the probe boundary; the public `latest()` control regressed 87.313 -> 103.689 ms at 32 drafts (+18.8%) and 48.983 -> 78.995 ms at 1,024 (+61.3%) | Traverse `liveDrafts` once to build both outputs, but keep the signature flat before memo-map lookup | Retry only without caching or mirrored membership, and pass both the frozen constructor probe and the controller public-`latest()` control at 2/32/1,024 drafts |
