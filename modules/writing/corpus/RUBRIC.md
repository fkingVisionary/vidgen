# Read-aloud rubric

Version `rubric-1.0`. Ten dimensions, each scored 0–10 by code from what the diagnostics and the script rules measured, each score with its reasons (`modules/writing/src/rubric.ts`). **Editorial telemetry**: it never gates a version and never overrides the factual checks. The script editor's own scores are recorded apart, as judgments.

> Generated from the code by `pnpm --filter @docengine/writing corpus:docs`.

Every dimension starts at 10 and loses points for what was found; the reasons say how many and why.

| Dimension | The question |
|---|---|
| Humanity | Does it sound like a person telling a story to one listener — people in it, no machine habits, no talk about the film? |
| Clarity | Can a listener follow it at speaking speed — one idea per sentence, one number per breath, no page syntax? |
| Spoken rhythm | Do sentence lengths vary organically — no runs of fragments, no runs of same-length sentences, no repeated openings or endings? |
| Historical context | Do the numbers and people arrive with the context a listener needs — what a sum meant at the time, who a person was? |
| Narrative restraint | Does it trust the audience — no trailer language, explained emotions, fake dramatic beats or teasing endings? |
| Information density | Does every paragraph add something — a fact, chronology, context, consequence, character, tension, uncertainty or payoff — without retelling? |
| Narrative progression | Does the story move — the question posed early, built on, answered at the end, without recaps? |
| Narration and pictures kept apart | Does the narration leave to the pictures what they show, and give what they cannot? |
| AI-fingerprint risk (10 = none) | How few machine-writing patterns does it carry (10 = none found)? |
| Pronunciation friendliness | Can a narrator say it cleanly — no tongue-twisters, symbols or unconfirmed names? |

## The editorial test above all of them

If I heard this as narration in a high-quality historical documentary, would I naturally assume a competent human documentary writer wrote it? Not “does it sound AI?”, not “does it sound cinematic?”, not “does it contain enough hooks?” — credible human documentary narration. The script editor answers it for every narration pass, as a judgment beside these measurements.
