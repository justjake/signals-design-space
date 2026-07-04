export const meta = {
  name: 'design-loop-round',
  description: 'One design-loop round: N authors -> 2 adversarial reviews each (codex + claude) -> synthesis -> judge',
  phases: [
    { title: 'Author', detail: 'fresh competing designs from SEEDS + NOTES' },
    { title: 'Review', detail: 'codex + claude adversarial reviews per design' },
    { title: 'Synthesize', detail: 'adjudicate findings, repaired final design, notes diff' },
    { title: 'Judge', detail: 're-walk acceptance battery, score, verdict' },
  ],
}

// args: { round: number, stances: [{key, brief, author?: 'claude'|'codex'}] }
// author defaults to 'claude'; author: 'codex' runs the author role through
// the codex CLI for cross-model design diversity.
const input = typeof args === 'string' ? JSON.parse(args) : args
if (!input || !input.round || !Array.isArray(input.stances) || input.stances.length < 2) {
  throw new Error('args required: { round: <int>, stances: [{key, brief, author?}, ...] (>=2) }')
}
const round = input.round
const rn = String(round).padStart(2, '0')
const DL = 'design-loop'
const roundDir = `${DL}/rounds/round-${rn}`

const AUTHOR_SCHEMA = {
  type: 'object',
  required: ['file', 'mechanismCount', 'seamTouchPoints', 'unwalkedCases', 'summary'],
  properties: {
    file: { type: 'string' },
    mechanismCount: { type: 'number' },
    seamTouchPoints: { type: 'number' },
    unwalkedCases: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['file', 'reviewer', 'blockers', 'high', 'verdict', 'worstSchedule'],
  properties: {
    file: { type: 'string' },
    reviewer: { type: 'string', enum: ['codex', 'claude'] },
    blockers: { type: 'number' },
    high: { type: 'number' },
    verdict: { type: 'string', enum: ['implementation-ready', 'repairable', 'architecturally-unsound'] },
    worstSchedule: { type: 'string' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object',
  required: ['file', 'notesDiffFile', 'confirmed', 'refuted', 'needsMeasurement', 'winner', 'mechanismCount', 'spikes'],
  properties: {
    file: { type: 'string' },
    notesDiffFile: { type: 'string' },
    confirmed: { type: 'number' },
    refuted: { type: 'number' },
    needsMeasurement: { type: 'number' },
    winner: { type: 'string' },
    mechanismCount: { type: 'number' },
    spikes: { type: 'array', items: { type: 'string' } },
  },
}
const JUDGE_SCHEMA = {
  type: 'object',
  required: ['file', 'newConfirmedBlockers', 'scores', 'openArchSpikes', 'exitRecommended', 'oneLine'],
  properties: {
    file: { type: 'string' },
    newConfirmedBlockers: { type: 'number' },
    scores: {
      type: 'object',
      required: ['correctness', 'mechanisms', 'seam', 'performance', 'explainability'],
      properties: {
        correctness: { type: 'number' }, mechanisms: { type: 'number' }, seam: { type: 'number' },
        performance: { type: 'number' }, explainability: { type: 'number' },
      },
    },
    openArchSpikes: { type: 'number' },
    exitRecommended: { type: 'boolean' },
    oneLine: { type: 'string' },
  },
}

const authorPrompt = (stance) => `You are an AUTHOR agent in round ${round} of the design loop at ${DL}/.
Read ${DL}/SEEDS/prompts/author.md FIRST and follow it exactly (including its
do-not-read list and its read-first list starting with SEEDS/background.md).

Your assigned stance: "${stance.key}" — ${stance.brief}

Write your complete design spec to: ${roundDir}/design-${stance.key}.md
Then return the structured summary the author prompt specifies.`

const codexAuthorPrompt = (stance) => `You are a RUNNER for a cross-LLM (codex) design AUTHOR in round ${round} of the design loop.
Do not design anything yourself. Steps:
1. Run exactly this command with the Bash tool, run_in_background: true (authoring a full spec may take 15-45 minutes):
   codex exec -c model_reasoning_effort=max --sandbox workspace-write --cd "$PWD" -o "${roundDir}/author-${stance.key}-final.txt" "You are a design AUTHOR. Read design-loop/SEEDS/prompts/author.md and follow it exactly, starting with its read-first list (design-loop/SEEDS/background.md first) and honoring its do-not-read list. Your assigned stance: ${stance.key} — ${stance.brief}. Write your complete design spec to the file ${roundDir}/design-${stance.key}.md using your file tools. Your final message must be ONLY the structured summary the author prompt specifies (file path, mechanism count, seam touch-point count, unwalked cases, 5-sentence summary)."
2. Wait for completion (you are re-invoked when the background command exits). If it failed or ${roundDir}/design-${stance.key}.md is missing or under 300 lines, retry ONCE.
3. Read ${roundDir}/author-${stance.key}-final.txt (and if needed skim the design file's headings) to fill the structured summary. Do not edit the design.
4. Return the structured summary. On double failure return mechanismCount: -1 with the error in summary.`

const claudeReviewPrompt = (stance, designFile) => `You are the CLAUDE REVIEWER in round ${round} of the design loop at ${DL}/.
Read ${DL}/SEEDS/prompts/reviewer-claude.md FIRST and follow it exactly
(including its do-not-read list).
Design under review: ${designFile}
Write your review to: ${roundDir}/review-${stance.key}-claude.md
Then return the structured summary (reviewer: "claude").`

const codexReviewPrompt = (stance, designFile) => `You are a RUNNER for the cross-LLM (codex) reviewer in round ${round} of the design loop.
Do not review the design yourself. Steps:
1. Run exactly this command with the Bash tool, run_in_background: true (it may take 5-20 minutes):
   codex exec -c model_reasoning_effort=max --sandbox read-only --cd "$PWD" -o "${roundDir}/review-${stance.key}-codex.md" "Read design-loop/SEEDS/prompts/reviewer-codex.md and follow it exactly. The design file under review is: ${designFile}"
2. Wait for it to finish (you will be re-invoked when the background command exits). If it fails or the output file is missing/empty, retry ONCE with the same command.
3. Read ${roundDir}/review-${stance.key}-codex.md and extract: blocker count, high count, the verdict line (map to one of: implementation-ready | repairable | architecturally-unsound), and the single worst failing schedule in one paragraph.
4. Return the structured summary (reviewer: "codex", file: the review path). If codex failed twice, return blockers: -1 and put the error in worstSchedule.`

// ---- Phase 1+2: authors, each design reviewed as soon as it lands (no cross-design barrier)
const perDesign = await pipeline(
  input.stances,
  (stance) => agent(
    stance.author === 'codex' ? codexAuthorPrompt(stance) : authorPrompt(stance),
    stance.author === 'codex'
      ? { label: `author-codex:${stance.key}`, phase: 'Author', schema: AUTHOR_SCHEMA, effort: 'low' }
      : { label: `author:${stance.key}`, phase: 'Author', schema: AUTHOR_SCHEMA, model: 'fable', effort: 'max' },
  ).then(a => a && { stance, design: a }),
  (r) => r && parallel([
    () => agent(claudeReviewPrompt(r.stance, r.design.file), {
      label: `review-claude:${r.stance.key}`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'fable', effort: 'max',
    }),
    () => agent(codexReviewPrompt(r.stance, r.design.file), {
      label: `review-codex:${r.stance.key}`, phase: 'Review', schema: REVIEW_SCHEMA, effort: 'low',
    }),
  ]).then(reviews => ({ ...r, reviews: reviews.filter(Boolean) })),
)

const rounds = perDesign.filter(Boolean)
if (rounds.length === 0) throw new Error('no designs produced')
log(`${rounds.length}/${input.stances.length} designs authored and reviewed`)

// ---- Phase 3: synthesis (barrier justified: adjudicates across ALL designs+reviews)
phase('Synthesize')
const inventory = rounds.map(r =>
  `- design: ${r.design.file} (stance ${r.stance.key}; ${r.design.mechanismCount} mechanisms; unwalked: ${r.design.unwalkedCases.join(', ') || 'none'})\n` +
  r.reviews.map(v => `  - review: ${v.file} (${v.reviewer}: ${v.blockers} blockers, ${v.high} high, verdict ${v.verdict})`).join('\n')
).join('\n')

const synth = await agent(`You are the SYNTHESIS agent for round ${round} of the design loop at ${DL}/.
Read ${DL}/SEEDS/prompts/synthesis.md FIRST and follow it exactly.
This round's artifacts:
${inventory}
Write the repaired final design to: ${roundDir}/synthesis.md
Write the proposed notes diff to: ${roundDir}/notes-diff.md
Then return the structured summary.`, { label: 'synthesis', phase: 'Synthesize', schema: SYNTH_SCHEMA, model: 'fable', effort: 'max' })
if (!synth) throw new Error('synthesis agent failed')

// ---- Phase 4: judge (independent; does not read reviews)
phase('Judge')
const judge = await agent(`You are the JUDGE for round ${round} of the design loop at ${DL}/.
Read ${DL}/SEEDS/prompts/judge.md FIRST and follow it exactly (including its
do-not-read list: no reviews, no prior rounds).
The final design under judgment: ${roundDir}/synthesis.md
Write your judgment to: ${roundDir}/judge.md
Then return the structured verdict.`, { label: 'judge', phase: 'Judge', schema: JUDGE_SCHEMA, model: 'fable', effort: 'max' })

return {
  round,
  designs: rounds.map(r => ({ stance: r.stance.key, file: r.design.file, mechanisms: r.design.mechanismCount, unwalked: r.design.unwalkedCases })),
  reviews: rounds.flatMap(r => r.reviews.map(v => ({ stance: r.stance.key, reviewer: v.reviewer, blockers: v.blockers, high: v.high, verdict: v.verdict }))),
  synthesis: synth,
  judge: judge ?? { error: 'judge failed — monitor must re-run judge before accepting the round' },
}
