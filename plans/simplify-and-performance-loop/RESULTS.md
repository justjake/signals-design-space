# Loop results

One durable row per completed round. Working raw evidence lives in
`/tmp/fx2-simplify-loop/<round>/` until the result is committed.

| Round | Base SHA | Change/concept removed | Focused performance | Verdict/lesson |
| --- | --- | --- | --- | --- |
| 01 | `1831581a9c6a515b5553d6bcc3a9f325e024964e` | Rejected `liveDrafts` + `Draft.cells` recipient selection; no production change retained | History-heavy median 44.618 -> 1.263 ms (-97.2%); 1,000 unrelated drafts 2.762 -> 44.748 ms (16.2x regression) | `REJECT`: replaced O(cell history) with O(all live drafts); avoiding both requires mirrored membership state or a dual-path policy |
| 02 | `31e1bbdd6cf7e0076e77f9bf061f80671b14796c` | Deleted unread `WorldState.rev`; fused live-ID filtering and membership detection; removed stale revision prose | Repeated-live-ID median 116.497 -> 84.403 ms (-27.6%); final controller median 85.025 ms (-27.0%) | `APPROVE` / `APPROVE`: `ids` is the payload, fresh wrapper identity prevents the render-time bailout; full final gate passed |

## Near-miss ledger

Measured performance improvements that failed the review bar, including
discarded intermediate revisions from an ultimately accepted round. Ultra
carries these forward as evidence; the implementer decides whether a clearer
design can reuse the mechanism.

| Round | Measured benefit | Why rejected | Reusable mechanism | Bar for reuse |
| --- | --- | --- | --- | --- |
| 01 | History-heavy equality-cutoff median 44.618 -> 1.263 ms in controller reproduction (-97.2%) | Adversarial control proved a 16.2x regression when unrelated live drafts dominate; a robust repair added state or dual algorithms | Select recipients from existing `liveDrafts` plus `Draft.cells` only if the selection can remain cell-local | Retry only with a cell-local design that adds no mirrored index or hybrid policy, passes both frozen probes, and directly pins exact multi-draft recipients |
| 02 | Repeated-live-ID reducer median 116.497 -> 84.403 ms (-27.6%); controller medians 83.794 and 84.674 ms (-28.1% and -27.3%) | `REVISE` pass 1: the record attributed `useState`'s eager bailout to `useReducer`; pass 2: `host.ts` still called `REPAIR_WAKE` a revision bump after deleting the revision | Delete unread `WorldState.rev` and fuse live-ID filtering with membership detection in one direct loop | Preserve stable `ids` identity and a fresh wrapper per reducer call; distinguish dispatch scheduling from render-time bailout prevention and remove stale revision-counter prose from production comments |
