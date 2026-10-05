# The Documentary Writing Corpus

The writing engine's editorial memory: what excellent documentary narration
sounds like, and what to avoid — taught by examples, retrieved a few at a time
for the blocks in front of the writer. No fine-tuning, no hidden prompt: every
example, its annotation and its version are here, and every narration pass
records which examples it was given.

```
corpus/
  README.md            this file
  STYLE_BIBLE.md       the house style — generated from src/bible.ts
  RUBRIC.md            the read-aloud rubric — generated from src/rubric.ts
  manifest.json        the corpus version and its change log
  index.ts             imports every example file (generated) so the build bundles them
  examples/
    positive/          models to follow (excellent, good), one file per category
    negative/          habits to avoid (bad), each with the house rewrite
    borderline/        judgment calls: right once, wrong when repeated
    house_style/       the house voice itself
  annotations/
    PATTERNS.md        the AI-pattern glossary — generated from src/docs.ts
  evaluations/         how runs are evaluated (see its README)
```

## An example

`WritingCorpusExample` in `packages/core/src/contracts/writing.ts`:

```json
{
  "id": "economics-p-years-of-pay",
  "version": 1,
  "text": "…",
  "category": "economics",
  "quality": "excellent",
  "traits": ["money_context", "number_in_context", "spoken_clarity"],
  "strengths": ["…"], "weaknesses": ["…"],
  "spokenRhythm": "…", "narrativeFunction": "…",
  "whyItWorks": "…",
  "source": { "type": "house" },
  "copyrightSafe": true,
  "approvedForRetrieval": true
}
```

A bad example also has `whyItFails` and `rewrite` (the house version, saying
the same facts and adding none); a borderline one says both what works and
what fails. Traits use a shared vocabulary that includes the AI-pattern ids
(`dramatic_transition`, `visual_description`, …): retrieval finds the bad
examples of a pattern the diagnostics flag.

## Rules

- **Copyright.** Original house writing, the editor's own, public domain or
  licensed text only. Never a transcript of a commercial documentary; never a
  recognisable line from one.
- **Generic.** Many subjects and eras; no subject of a film in production.
- **Facts.** Style examples, not facts: invented, generic situations are
  preferred over claims about real people. A prompt says so, and the evidence
  rules reject any name or figure that leaks from an example.
- **Versioned.** Change an example → bump its `version`; change the corpus →
  add a line to `manifest.json`. The corpus version also carries a hash of the
  exact wording, so an unannounced edit still changes it.
- **Reviewed.** Edit the JSON, then run
  `pnpm --filter @docengine/writing corpus:docs` (regenerates the documents
  and `index.ts`) and the tests (`modules/writing/src/corpus.test.ts` validates
  every file).

## Our own work

The most important examples will be our own approved writing. An approved
script proposes candidates (dashboard: Script → Versions → "Propose
house-style candidates"); each enters retrieval only when a person approves
it and says why it works (dashboard: House style). Nothing generated feeds the
corpus on its own.
