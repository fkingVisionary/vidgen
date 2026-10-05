import { AI_PATTERN_LABELS, AI_PATTERNS, RUBRIC_DIMENSION_LABELS, RUBRIC_DIMENSIONS, type AiPattern } from '@docengine/core';
import { RUBRIC_QUESTIONS, RUBRIC_VERSION } from './rubric.ts';

/**
 * The corpus documents generated from code (the single source of truth):
 * RUBRIC.md and annotations/PATTERNS.md. STYLE_BIBLE.md comes from bible.ts.
 * `pnpm --filter @docengine/writing corpus:docs` writes them; a test fails
 * when a file differs from what the code says.
 */

/** What each AI pattern looks like and when it warns. */
export const PATTERN_NOTES: Record<AiPattern, { kind: 'HARD' | 'DENSITY'; looksLike: string; warns: string }> = {
  stock_phrase: { kind: 'HARD', looksLike: '“little did they know”, “a testament to”, “delve”, “the stage was set”', warns: 'wherever it appears' },
  dramatic_transition: { kind: 'HARD', looksLike: '“And then…”, “That’s when…”, “But this was only the beginning”, “Everything was about to change”, “changed everything”', warns: 'wherever it appears' },
  hype_adverb: { kind: 'HARD', looksLike: '“Incredibly,” “Remarkably,” “Shockingly,” opening a sentence', warns: 'wherever it appears' },
  imagine_opener: { kind: 'HARD', looksLike: '“Imagine…”, “Picture this”; an unneeded “What if…” (a density pattern: fine once)', warns: '“Imagine” anywhere; “What if” from the second' },
  trailer_language: { kind: 'HARD', looksLike: '“destiny”, “changed forever”, “against all odds”, “a story of greed, ambition and betrayal”', warns: 'wherever it appears' },
  mystery_language: { kind: 'HARD', looksLike: '“shrouded in mystery”, “the hidden truth”, “dark secrets”, “lost to history”', warns: 'wherever it appears' },
  emotion_explained: { kind: 'HARD', looksLike: '“a palpable sense of dread”, “hearts pounding”, “the weight of history”, “heartbreaking”', warns: 'wherever it appears' },
  truth_reveal: { kind: 'DENSITY', looksLike: '“The truth is…”, “In reality…” (“Here’s the thing” is always flagged)', warns: 'from the second' },
  micro_hook: { kind: 'HARD', looksLike: 'a block ending on a tease: “But that was about to change.”, “Or so they thought.”, “It wouldn’t last.”', warns: 'wherever it appears' },
  contrast_formula: { kind: 'DENSITY', looksLike: '“not X, but Y”; “It wasn’t X. It was Y.” — a good line once, a tic when repeated', warns: 'two or more, and more than one per 500 words' },
  qa_pair: { kind: 'DENSITY', looksLike: 'a short question answered at once by a fragment: “The result? Chaos.”', warns: 'from the second' },
  fragment_run: { kind: 'DENSITY', looksLike: 'three or more sentences of one to three words in a row: “A pen. A ledger. A fortune.”', warns: 'from the second run' },
  em_dash: { kind: 'DENSITY', looksLike: 'two or more dashes in a block, standing in for sentences', warns: 'three or more blocks, more than one per 400 words' },
  metaphor_stack: { kind: 'DENSITY', looksLike: 'two figures of speech in a block (“like a…”, “a sea of…”); clichés (“a house of cards”) always', warns: 'clichés anywhere; stacks from the second block' },
  rhetorical_question: { kind: 'DENSITY', looksLike: 'questions the narrator asks; two in a row are always flagged', warns: 'two in a row, or more than one a minute' },
  repeated_ending: { kind: 'DENSITY', looksLike: 'three blocks in a row ending the same way (a short fragment, the same last word)', warns: 'from the second occurrence' },
  length_repetition: { kind: 'DENSITY', looksLike: 'four or more sentences in a row within two words of the same length', warns: 'from the second run' },
  visual_description: { kind: 'HARD', looksLike: 'narration describing what the picture shows: gestures, glances, flickering light, objects that shrug, “we see…”, or the block’s own visual direction repeated', warns: 'wherever it appears' },
};

export function patternsMarkdown(): string {
  return [
    '# AI-pattern glossary',
    '',
    'The signals the writing engine measures (`modules/writing/src/fingerprints.ts`). They are **warnings, not failures**: an editor decides. HARD patterns are wrong wherever they appear; DENSITY patterns are fine once and formulaic when they pile up, so they warn only past a threshold for the whole script. The fingerprint score (0–100) weighs a HARD signal three times a DENSITY one and counts DENSITY signals only past their threshold. It is a heuristic indicator for the editor, not a detector of who wrote a text.',
    '',
    '> Generated from the code by `pnpm --filter @docengine/writing corpus:docs`.',
    '',
    '| Pattern | Id | Kind | Looks like | Warns |',
    '|---|---|---|---|---|',
    ...AI_PATTERNS.map((p) => `| ${AI_PATTERN_LABELS[p]} | \`${p}\` | ${PATTERN_NOTES[p].kind} | ${PATTERN_NOTES[p].looksLike} | ${PATTERN_NOTES[p].warns} |`),
    '',
  ].join('\n');
}

export function rubricMarkdown(): string {
  return [
    '# Read-aloud rubric',
    '',
    `Version \`${RUBRIC_VERSION}\`. Ten dimensions, each scored 0–10 by code from what the diagnostics and the script rules measured, each score with its reasons (\`modules/writing/src/rubric.ts\`). **Editorial telemetry**: it never gates a version and never overrides the factual checks. The script editor's own scores are recorded apart, as judgments.`,
    '',
    '> Generated from the code by `pnpm --filter @docengine/writing corpus:docs`.',
    '',
    'Every dimension starts at 10 and loses points for what was found; the reasons say how many and why.',
    '',
    '| Dimension | The question |',
    '|---|---|',
    ...RUBRIC_DIMENSIONS.map((d) => `| ${RUBRIC_DIMENSION_LABELS[d]} | ${RUBRIC_QUESTIONS[d]} |`),
    '',
    '## The editorial test above all of them',
    '',
    'If I heard this as narration in a high-quality historical documentary, would I naturally assume a competent human documentary writer wrote it? Not “does it sound AI?”, not “does it sound cinematic?”, not “does it contain enough hooks?” — credible human documentary narration. The script editor answers it for every narration pass, as a judgment beside these measurements.',
    '',
  ].join('\n');
}
