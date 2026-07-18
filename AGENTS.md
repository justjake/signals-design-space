## Doc comments, public documentation

- Format multiline doc comments with `/**` and `*/` on their own lines. Keep a doc comment on one line only when the entire comment fits as `/** single line */`.
- audience: intermediate engineer with no signals familiarity, some beginner react knowledge
- files should make sense reading from top to bottom; re-order as necessary
- Plain statements over compressed cleverness. If a sentence needs to be read twice, it's wrong even if it's short.
- avoid long blocks of text (>7 lines without \n\n) as humans struggle to scan; break up with lists can help
- Explain why, and the non-obvious parts of the contract.
- do not write UPPER CASE WORDS at random
- Avoid inventing new terms of art if an existing concept already exists in React or existing public signals frameworks like Solid. Avoid jargon or abbreviations, a few normal words will do.
- Note any unusual code structures or performance critical code structures; for performance stuff it's nice to cite some evidence or exact numbers
- do not document lore.
  - Do not reference unrelated packages
  - Do not reference sections in design docs or research markdowns
- if each item in a list gets its own explanation, write a bulleted list — one `- item: explanation` per line — never an inline comma chain. Inline lists are fine only for bare enumerations with nothing to say per item.
- write every comment for a reader who has seen only this file: never use a name or phrase defined elsewhere ("effect()'s source union") as shorthand for an explanation. A valid TSDoc {@link} cross-reference may follow a self-contained explanation, never substitute for one.
- Never open a doc comment with a definite-article label ("The subscribing read hook.", "The poke walk: ..."). Write a sentence with a subject and a verb; introduce a term of art at the end ("... — the poke walk") if other comments refer to it. Anchored descriptions of what a variable holds ("The world an evaluation is running in") are fine.
- Every exported type, interface, and constant gets a doc comment.
