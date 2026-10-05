# Evaluations

Every script version the writing engine touches carries its own evaluation in
`scripts.content.narration` (shown on the Script page's Editorial tab and in
the job's final log entry):

- the AI-pattern fingerprint and spoken-rhythm profile **before** and **after**
  the Human Narration Pass, and the read-aloud rubric (RUBRIC.md);
- the corpus version and every example (id@version) the pass was given;
- the money context the evidence supports, what was used, and the gaps;
- the name layer and the pronunciation candidates;
- the lineage from the base version, from which the change report
  (ORIGINAL → REVISED → WHY, block by block) is built on demand.

The script editor answers the narration checklist against the base version —
first of all: *if you heard this as narration in a high-quality historical
documentary, would you naturally assume a competent human documentary writer
wrote it?* That is a judgment, recorded apart from the measurements.

Regression cases live in the tests: `apps/api/src/tulip-opening.int.test.ts`
(the Tulip opening end to end, through the Voice Engine with the MOCK voice)
and `modules/script/src/script.int.test.ts` (the pass, its convergence and
its failure modes).
