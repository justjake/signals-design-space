# Round <NN>: <slug>

## Before editing

- Base SHA:
- Candidate chosen by implementer:
- Primary benchmark command:
- Fixed repetitions:
- Raw baseline output:
- Causal performance hypothesis:
- Measurement integrity boundary:

The sections below may evolve during implementation but must be complete before
handoff.

## Opportunity

Why this is the highest-leverage current comprehension and execution cost,
with source/runtime evidence.

## Current model

- Canonical state and owner:
- Duplicate representations/translations:
- Representative operation, step by step:
- Hot-path allocations, calls, branches, or indirections:

## Chosen change

- Concept/representation/operation expected to disappear:
- Ownership before -> after:
- Code/control flow expected to disappear:
- Things that must remain separate, and why:
- New state or abstraction, if any, and why deletion alone cannot work:

## Alternatives considered

Every materially different approach considered, with its tradeoff and why the
chosen approach is stronger. This is the implementer's decision, not a request
for controller approval.

## Semantic boundary

- Existing focused tests:
- Tests to add/change:
- Observable behavior that must remain identical:
- Material edge cases and how the existing contract resolves them:

## Integrity checks

Why the selected benchmark exercises the changed path and why no observable
work, timing boundary, configuration, or input is changing.

## Abandon rule

What evidence should make the implementer replace or abandon this approach
instead of adding compensating complexity.
