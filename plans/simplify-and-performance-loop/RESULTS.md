# Loop results

One durable row per completed round. Working raw evidence lives in
`/tmp/fx2-simplify-loop/<round>/` until the result is committed.

| Round | Base SHA | Change/concept removed | Focused performance | Verdict/lesson |
| --- | --- | --- | --- | --- |
| 01 | `1831581a9c6a515b5553d6bcc3a9f325e024964e` | Rejected `liveDrafts` + `Draft.cells` recipient selection; no production change retained | History-heavy median 44.618 -> 1.263 ms (-97.2%); 1,000 unrelated drafts 2.762 -> 44.748 ms (16.2x regression) | `REJECT`: replaced O(cell history) with O(all live drafts); avoiding both requires mirrored membership state or a dual-path policy |

## Near-miss ledger

Measured performance improvements that failed the review bar, including
discarded intermediate revisions from an ultimately accepted round. Ultra
carries these forward as evidence; the implementer decides whether a clearer
design can reuse the mechanism.

| Round | Measured benefit | Why rejected | Reusable mechanism | Bar for reuse |
| --- | --- | --- | --- | --- |
| 01 | History-heavy equality-cutoff median 44.618 -> 1.263 ms in controller reproduction (-97.2%) | Adversarial control proved a 16.2x regression when unrelated live drafts dominate; a robust repair added state or dual algorithms | Select recipients from existing `liveDrafts` plus `Draft.cells` only if the selection can remain cell-local | Retry only with a cell-local design that adds no mirrored index or hybrid policy, passes both frozen probes, and directly pins exact multi-draft recipients |
