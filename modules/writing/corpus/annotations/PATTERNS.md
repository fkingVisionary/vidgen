# AI-pattern glossary

The signals the writing engine measures (`modules/writing/src/fingerprints.ts`). They are **warnings, not failures**: an editor decides. HARD patterns are wrong wherever they appear; DENSITY patterns are fine once and formulaic when they pile up, so they warn only past a threshold for the whole script. The fingerprint score (0–100) weighs a HARD signal three times a DENSITY one and counts DENSITY signals only past their threshold. It is a heuristic indicator for the editor, not a detector of who wrote a text.

> Generated from the code by `pnpm --filter @docengine/writing corpus:docs`.

| Pattern | Id | Kind | Looks like | Warns |
|---|---|---|---|---|
| Stock phrase | `stock_phrase` | HARD | “little did they know”, “a testament to”, “delve”, “the stage was set” | wherever it appears |
| Fake dramatic beat | `dramatic_transition` | HARD | “And then…”, “That’s when…”, “But this was only the beginning”, “Everything was about to change”, “changed everything” | wherever it appears |
| Hype adverb | `hype_adverb` | HARD | “Incredibly,” “Remarkably,” “Shockingly,” opening a sentence | wherever it appears |
| "Imagine…" opener | `imagine_opener` | HARD | “Imagine…”, “Picture this”; an unneeded “What if…” (a density pattern: fine once) | “Imagine” anywhere; “What if” from the second |
| Trailer language | `trailer_language` | HARD | “destiny”, “changed forever”, “against all odds”, “a story of greed, ambition and betrayal” | wherever it appears |
| Generic mystery language | `mystery_language` | HARD | “shrouded in mystery”, “the hidden truth”, “dark secrets”, “lost to history” | wherever it appears |
| Emotion explained | `emotion_explained` | HARD | “a palpable sense of dread”, “hearts pounding”, “the weight of history”, “heartbreaking” | wherever it appears |
| "The truth is…" | `truth_reveal` | DENSITY | “The truth is…”, “In reality…” (“Here’s the thing” is always flagged) | from the second |
| Micro-hook ending | `micro_hook` | HARD | a block ending on a tease: “But that was about to change.”, “Or so they thought.”, “It wouldn’t last.” | wherever it appears |
| "Not X, but Y" formula | `contrast_formula` | DENSITY | “not X, but Y”; “It wasn’t X. It was Y.” — a good line once, a tic when repeated | two or more, and more than one per 500 words |
| Question answered by a fragment | `qa_pair` | DENSITY | a short question answered at once by a fragment: “The result? Chaos.” | from the second |
| Run of fragments | `fragment_run` | DENSITY | three or more sentences of one to three words in a row: “A pen. A ledger. A fortune.” | from the second run |
| Em-dashes | `em_dash` | DENSITY | two or more dashes in a block, standing in for sentences | three or more blocks, more than one per 400 words |
| Stacked metaphors | `metaphor_stack` | DENSITY | two figures of speech in a block (“like a…”, “a sea of…”); clichés (“a house of cards”) always | clichés anywhere; stacks from the second block |
| Rhetorical questions | `rhetorical_question` | DENSITY | questions the narrator asks; two in a row are always flagged | two in a row, or more than one a minute |
| Repeated endings | `repeated_ending` | DENSITY | three blocks in a row ending the same way (a short fragment, the same last word) | from the second occurrence |
| Same-length sentences | `length_repetition` | DENSITY | four or more sentences in a row within two words of the same length | from the second run |
| Describes the picture | `visual_description` | HARD | narration describing what the picture shows: gestures, glances, flickering light, objects that shrug, “we see…”, or the block’s own visual direction repeated | wherever it appears |
