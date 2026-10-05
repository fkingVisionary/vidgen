import { RUBRIC_DIMENSIONS, type AiSignal, type FingerprintSummary, type RhythmProfile, type RubricDimension, type RubricScore } from '@docengine/core';

/**
 * The read-aloud rubric: ten dimensions scored 0–10 by code from what the
 * diagnostics and the script rules measured — each score with its reasons, so
 * an editor can see exactly why. Telemetry: it never gates a version and never
 * overrides the factual checks. (The script editor's own scores are kept
 * apart, as judgments.)
 */

export const RUBRIC_VERSION = 'rubric-1.0';

export interface RubricInput {
  fingerprint: FingerprintSummary;
  signals: readonly AiSignal[];
  rhythm: RhythmProfile;
  /** Script rule findings by kind (warnings and blocking). */
  findings: Readonly<Record<string, number>>;
  money: { mentions: number; contextualised: number; withContextAvailable: number; gaps: number };
  names: { candidates: number };
}

/** What each dimension asks — the questions RUBRIC.md documents. */
export const RUBRIC_QUESTIONS: Record<RubricDimension, string> = {
  HUMANITY: 'Does it sound like a person telling a story to one listener — people in it, no machine habits, no talk about the film?',
  CLARITY: 'Can a listener follow it at speaking speed — one idea per sentence, one number per breath, no page syntax?',
  SPOKEN_RHYTHM: 'Do sentence lengths vary organically — no runs of fragments, no runs of same-length sentences, no repeated openings or endings?',
  HISTORICAL_CONTEXT: 'Do the numbers and people arrive with the context a listener needs — what a sum meant at the time, who a person was?',
  NARRATIVE_RESTRAINT: 'Does it trust the audience — no trailer language, explained emotions, fake dramatic beats or teasing endings?',
  INFORMATION_DENSITY: 'Does every paragraph add something — a fact, chronology, context, consequence, character, tension, uncertainty or payoff — without retelling?',
  NARRATIVE_PROGRESSION: 'Does the story move — the question posed early, built on, answered at the end, without recaps?',
  VISUAL_SEPARATION: 'Does the narration leave to the pictures what they show, and give what they cannot?',
  AI_FINGERPRINT_RISK: 'How few machine-writing patterns does it carry (10 = none found)?',
  PRONUNCIATION_FRIENDLINESS: 'Can a narrator say it cleanly — no tongue-twisters, symbols or unconfirmed names?',
};

const HARD_RESTRAINT = new Set(['dramatic_transition', 'hype_adverb', 'trailer_language', 'mystery_language', 'emotion_explained', 'micro_hook', 'stock_phrase', 'imagine_opener', 'truth_reveal']);

export function rubric(input: RubricInput): RubricScore[] {
  const f = (k: string) => input.findings[k] ?? 0;
  const r = input.rhythm;
  const fp = input.fingerprint;
  const visual = input.signals.filter((s) => s.pattern === 'visual_description').length;
  const restraint = input.signals.filter((s) => s.kind === 'HARD' && HARD_RESTRAINT.has(s.pattern));
  const scores: Record<RubricDimension, { score: number; reasons: string[] }> = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, { score: 10, reasons: [] as string[] }])) as never;
  const take = (d: RubricDimension, amount: number, reason: string) => {
    if (amount <= 0) return;
    scores[d].score -= amount;
    scores[d].reasons.push(`−${amount % 1 ? amount.toFixed(1) : amount}: ${reason}`);
  };
  const per = (n: number, each: number, cap: number) => Math.min(cap, n * each);

  // Humanity.
  take('HUMANITY', Math.round(fp.score / 10), `AI-pattern score ${fp.score}/100`);
  take('HUMANITY', f('LOW_HUMAN_PRESENCE') ? 1.5 : 0, 'little narration with people in it');
  take('HUMANITY', per(f('META_NARRATION'), 0.5, 2), `${f('META_NARRATION')} line(s) about the film itself`);
  take('HUMANITY', per(f('CONSECUTIVE_FACTS'), 0.5, 1.5), 'runs of documented facts with nobody in them');
  // Clarity.
  take('CLARITY', per(f('LONG_SENTENCES'), 0.5, 2), 'sentences too long for one breath');
  take('CLARITY', per(f('WRITTEN_SYNTAX'), 0.5, 2), 'page syntax (colons, semicolons, parentheses)');
  take('CLARITY', per(f('NUMBER_DENSE'), 0.5, 1.5), 'several numbers in one sentence');
  take('CLARITY', per(f('LIST_SENTENCE'), 0.5, 1), 'lists in one breath');
  take('CLARITY', per(f('NAME_LOAD'), 0.5, 1), 'several new names at once');
  take('CLARITY', per(f('NOUN_HEAVY'), 0.5, 1.5), 'essay prose (abstract nouns)');
  take('CLARITY', r.clausesPerSentence > 2.4 ? 1 : 0, `${r.clausesPerSentence} clauses a sentence on average`);
  // Spoken rhythm.
  take('SPOKEN_RHYTHM', r.sentences >= 8 ? (r.variation < 0.3 ? 3 : r.variation < 0.4 ? 1.5 : 0) : 0, `sentence lengths barely vary (spread ${r.variation})`);
  take('SPOKEN_RHYTHM', r.variation > 1.1 ? 1 : 0, `sentence lengths swing wildly (spread ${r.variation})`);
  take('SPOKEN_RHYTHM', per(r.sameLengthRuns, 0.5, 2), `${r.sameLengthRuns} run(s) of same-length sentences`);
  take('SPOKEN_RHYTHM', r.longestFragmentRun >= 4 ? 2 : r.longestFragmentRun === 3 ? 1 : 0, `${r.longestFragmentRun} fragments in a row`);
  take('SPOKEN_RHYTHM', r.fragmentShare > 0.2 ? 1.5 : 0, `${Math.round(r.fragmentShare * 100)}% of sentences are fragments`);
  take('SPOKEN_RHYTHM', r.sentences >= 10 && r.repeatedOpenings > r.sentences * 0.1 ? 1 : 0, `${r.repeatedOpenings} sentences open like the one before`);
  take('SPOKEN_RHYTHM', r.endingRepetition > 0.25 ? 1 : 0, `${Math.round(r.endingRepetition * 100)}% of blocks end like the one before`);
  // Historical context.
  const bare = input.money.withContextAvailable;
  take('HISTORICAL_CONTEXT', per(bare, 1.5, 5), `${bare} sum(s) said without the context the evidence offers`);
  take('HISTORICAL_CONTEXT', per(input.money.gaps, 0.5, 1.5), `${input.money.gaps} sum(s) the evidence gives no context for`);
  take('HISTORICAL_CONTEXT', per(f('PERSON_UNINTRODUCED'), 1, 2), 'people named without saying who they are');
  // Narrative restraint.
  take('NARRATIVE_RESTRAINT', per(restraint.length, 1.5, 7), `${restraint.length} trailer-style moment(s): ${[...new Set(restraint.map((s) => s.pattern))].join(', ')}`);
  take('NARRATIVE_RESTRAINT', fp.overThreshold.includes('rhetorical_question') ? 1 : 0, 'too many rhetorical questions');
  take('NARRATIVE_RESTRAINT', fp.overThreshold.includes('contrast_formula') ? 1 : 0, '"not X, but Y" used as a formula');
  // Information density.
  take('INFORMATION_DENSITY', per(f('PASSENGER_FACT'), 1, 3), 'facts along for the ride');
  take('INFORMATION_DENSITY', per(f('RETOLD_CONTENT'), 1, 3), 'material said twice');
  take('INFORMATION_DENSITY', per(f('RECAP_SECTION'), 1, 2), 'recap sections');
  take('INFORMATION_DENSITY', per(f('SOURCE_CHATTER'), 0.5, 1), 'sources named only to cite them');
  take('INFORMATION_DENSITY', per(visual, 0.5, 2), 'sentences spent on what the picture shows');
  // Narrative progression.
  take('NARRATIVE_PROGRESSION', f('CENTRAL_QUESTION_NOT_POSED') ? 3 : 0, 'the central question is never posed');
  take('NARRATIVE_PROGRESSION', f('CENTRAL_QUESTION_ABANDONED') ? 3 : 0, 'the central question is not answered');
  take('NARRATIVE_PROGRESSION', f('QUESTION_POSED_LATE') ? 1 : 0, 'the question comes late');
  take('NARRATIVE_PROGRESSION', per(f('CLAIM_RETOLD'), 1, 2), 'the same claim explained again and again');
  take('NARRATIVE_PROGRESSION', f('ENDING_DRAG') ? 1 : 0, 'the ending drags');
  take('NARRATIVE_PROGRESSION', per(f('EXPOSITION_HEAVY'), 1, 2), 'sections dominated by exposition');
  // Visual separation.
  take('VISUAL_SEPARATION', per(visual, 1.5, 8), `${visual} sentence(s) describing what the picture shows`);
  // AI-fingerprint risk.
  take('AI_FINGERPRINT_RISK', Math.round(fp.score / 10), `${fp.signals} signal(s): ${Object.entries(fp.perPattern).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  // Pronunciation friendliness.
  take('PRONUNCIATION_FRIENDLINESS', per(r.tongueTwisters.length, 0.5, 3), `${r.tongueTwisters.length} tongue-twister(s)`);
  take('PRONUNCIATION_FRIENDLINESS', per(input.names.candidates, 0.5, 3), `${input.names.candidates} name(s) waiting for a pronunciation decision`);
  take('PRONUNCIATION_FRIENDLINESS', per(f('UNSPOKEN_SYMBOLS'), 0.5, 2), 'symbols or abbreviations a narrator cannot read as written');

  return RUBRIC_DIMENSIONS.map((d) => ({ dimension: d, score: Math.max(0, Math.min(10, Math.round(scores[d].score * 2) / 2)), reasons: scores[d].reasons.length ? scores[d].reasons : ['nothing found'] }));
}
