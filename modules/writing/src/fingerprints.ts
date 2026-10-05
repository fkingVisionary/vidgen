import { AI_PATTERNS, SCRIPT_TIMING, type AiPattern, type AiSignal, type FingerprintSummary } from '@docengine/core';
import { normalize, wordTokens } from '@docengine/story/shared';
import { clip, countWords, maskQuotes, narrationOnly, narratorSentences, quotes, sentencesOf, type NarrationBlock, type Sentence } from './text.ts';

/**
 * AI-pattern diagnostics: the habits that make narration sound
 * machine-written. Each finding is a signal for an editor, never a failure.
 * HARD patterns are wrong wherever they appear ("little did they know");
 * DENSITY patterns are fine once and formulaic when they pile up ("It wasn't
 * a flower. It was a promise." — a good line the first time, a tic the third),
 * so they warn only past a threshold for the whole script.
 *
 * Generic English heuristics: no subject, era or documentary is assumed.
 * Linear passes only — the rules run once per proposed change.
 */

/** Stock phrases (the lexicon the script rules and prompts share). Lower case; matched in any case on the narrator's own words (`stockPhrases`). */
export const STOCK_PHRASES = [
  "here's where things get interesting",
  'here is where things get interesting',
  "but here's the thing",
  'little did they know',
  'little did he know',
  'little did she know',
  'fast forward',
  'fast-forward',
  'buckle up',
  "let's dive",
  'dive into the world',
  'dive into the story',
  'dive into the details',
  'dive into the history',
  'in a world where',
  "but that's not all",
  'the rest is history',
  "it's important to note",
  'it is important to note',
  "it's worth noting",
  'it is worth noting',
  'needless to say',
  'at the end of the day',
  'plot twist',
  "you won't believe",
  'game-changer',
  'game changer',
  'a testament to',
  'tapestry',
  'delve',
  'stood the test of time',
  'in the annals of history',
  'nothing would ever be the same',
  'one thing is certain',
  'only time will tell',
  'a perfect storm',
  'the stage was set',
  'a pivotal moment',
  'a turning point in history',
  'sent shockwaves',
  'a cautionary tale',
  'the rest, as they say',
  'history would remember',
] as const;

/** Each stock phrase as a pattern on the narrator's own text: any capitals, typographic apostrophes and dashes, from the start of a word. */
const STOCK = STOCK_PHRASES.map((phrase) => ({ phrase, re: new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/'/g, "['‘’]").replace(/-/g, '[-‐-―]').replace(/ /g, '\\s+')}`, 'giu') }));

/** A match that starts with a capital inside a sentence belongs to a name ("the Tapestry Room"), not to the narrator's phrase. */
const inName = (text: string, at: number) => /\p{Lu}/u.test(text[at] ?? '') && !/(?:^|\n|[.!?…:]["”’)]?)\s*["“‘(]?$/u.test(text.slice(0, at));

/** The stock phrases a text says in the narrator's own words: not inside a quotation, not as part of a name ("the Tapestry Room"). */
export function stockPhrases(text: string): string[] {
  const raw = maskQuotes(text);
  return STOCK.filter(({ re }) => [...raw.matchAll(re)].some((m) => !inName(raw, m.index!))).map((x) => x.phrase);
}

interface SentenceRule {
  pattern: AiPattern;
  kind: 'HARD' | 'DENSITY';
  re: RegExp;
}

/** Patterns found in one sentence (normalized: lower case, plain quotes and dashes). */
const SENTENCE_RULES: SentenceRule[] = [
  // Fake dramatic beats and portentous closers.
  { pattern: 'dramatic_transition', kind: 'HARD', re: /^(?:and|but) then\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /\bthat'?s (?:when|where) (?:it (?:all|gets|got|began|begins|started|starts|went|goes)|things|everything|the trouble|the story)\b|\bthat'?s when it (?:happened|changed)\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /^that'?s when\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /\b(?:was|is) (?:only|just) the beginning\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /\b(?:everything|all of (?:that|this)|things|it all) (?:was|were|is) about to change\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /^(?:and |but |so )?what happened next\b|\bbut what happened next\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /\bthis is (?:where|when) (?:everything|it all|things|the story) (?:changed|changes|went wrong|goes wrong|gets? (?:interesting|strange|dark))\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /\b(?:would change|changed) everything\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /\bbut (?:there was|there's|there is) (?:a|one) (?:problem|catch|twist)\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /^it all (?:started|began) (?:with|when)\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /\bthe story doesn'?t end there\b/ },
  { pattern: 'dramatic_transition', kind: 'HARD', re: /\bthings were about to\b/ },
  // Hype adverbs as openers.
  { pattern: 'hype_adverb', kind: 'HARD', re: /^(?:incredibly|remarkably|astonishingly|shockingly|unbelievably|amazingly|staggeringly|interestingly|fascinatingly|crucially),/ },
  // "Imagine…" and "What if…".
  { pattern: 'imagine_opener', kind: 'HARD', re: /^(?:now,? )?(?:imagine|picture (?:this|it|the \w+|an? \w+)|close your eyes)\b/ },
  { pattern: 'imagine_opener', kind: 'DENSITY', re: /^(?:but |so |and )?what if\b/ },
  // Trailer language.
  { pattern: 'trailer_language', kind: 'HARD', re: /^destiny\b|\b(?:(?:was|is|seemed) destiny|(?:his|her|their|its|our) destiny|a date with destiny|destiny (?:awaited|awaits|called|beckoned|had)|fate had other plans|forever changed|changed forever|the unthinkable|unimaginable|would never be the same|against all odds|in a single moment|rocked the (?:world|nation|city)|the world would never|the stakes (?:have never been|could not be|couldn'?t be|were never) higher|one (?:man|woman)'s (?:obsession|quest|gamble|dream))\b/ },
  { pattern: 'trailer_language', kind: 'HARD', re: /\ba (?:story|tale) of (?:\w+, ){1,4}(?:and )?\w+\b/ },
  // Generic mystery.
  { pattern: 'mystery_language', kind: 'HARD', re: /\b(?:shrouded in (?:mystery|secrecy)|hidden truth|dark secrets?|the truth behind|untold story|lost to history|an enigma|cloaked in (?:mystery|secrecy)|veil of secrecy|mysterious circumstances|secrets? (?:that|which) would)\b/ },
  // Emotion explained.
  { pattern: 'emotion_explained', kind: 'HARD', re: /\b(?:palpable|a (?:deep |growing )?sense of (?:dread|unease|wonder|awe|despair|foreboding)|hearts? (?:pounding|racing|sank|sinking)|the weight of (?:it all|history|the moment)|sends? (?:a )?chills?|heart-?breaking|gut-?wrenching|breath-?taking|spine-?(?:chilling|tingling)|the air (?:was|is) thick with (?:tension|fear|dread|anticipation|menace|suspicion|excitement|expectation)|you can (?:almost )?(?:feel|taste|smell) the)\b/ },
  // "The truth is…"
  { pattern: 'truth_reveal', kind: 'HARD', re: /^(?:but )?here'?s (?:the thing|the truth|the twist|the kicker)\b/ },
  { pattern: 'truth_reveal', kind: 'DENSITY', re: /^(?:but )?(?:the truth is|the truth was|in reality|the reality (?:is|was)|the real story)\b/ },
  // Cliché figures of speech.
  { pattern: 'metaphor_stack', kind: 'HARD', re: /\b(?:a house of cards|a ticking time bomb|a powder keg|a double-edged sword|the tip of the iceberg|the eye of the storm|a perfect storm|a whirlwind of|a rollercoaster|a race against time)\b/ },
];

/** Closing teases: a block (or a section) that ends by promising drama instead of delivering it. */
const MICRO_HOOK: RegExp[] = [
  /\b(?:that|this|it|things|everything) (?:was|were) about to change\.?$/,
  /^or so (?:they|he|she|it|everyone|we) thought\.?$/,
  /^but not for long\.?$/,
  /^(?:it|that|this|the calm|the peace) (?:wouldn'?t|would not|did not|didn'?t) last\.?$/,
  /\bwould (?:soon )?(?:prove|turn out) to be (?:a )?(?:fatal|costly|terrible|grave|deadly) (?:mistake|error)\.?$/,
  /^(?:they|he|she) (?:had|have) no idea\b/,
  /^but (?:fate|history|the past) had other plans\.?$/,
  /^what (?:they|he|she|we) (?:found|discovered|learned) would\b/,
  /^(?:and )?(?:nobody|no one) saw (?:it|what was) coming\.?$/,
  /^(?:but )?the worst was (?:yet|still) to come\.?$/,
];

/** Body parts, light and ambience: what a camera shows. */
const SEEN = /\b(?:thumb|thumbs|finger|fingers|hand|hands|eyes|eye|brow|brows|lips|jaw|shoulder|shoulders|knuckles|candle|candles|candlelight|lamp|lamplight|shadow|shadows|smoke|dust|light)\b/;
/** Gestures: what the picture carries better than words. */
const GESTURE = /\b(?:leans?|leaning|glances?|glancing|nods?|nodding|shrugs?|shrugging|sighs?|sighing|smiles?|smiling|frowns?|frowning|blinks?|squints?|fidgets?|drums?|tapping|taps?|wipes?|wiping|twitches?)\b/;
/** Ambient movement: a picture only with something seen ("candlelight flickers"); prices, credit and doubt drift, hover and tighten too. */
const AMBIENT = /\b(?:flickers?|flickering|gutters?|guttering|glints?|gleams?|shimmers?|swirls?|creaks?|rustles?|hovers?|hovering|trembles?|trembling|lingers?|lingering|drifts?|dances?|dancing|curls?|tightens?|narrows?)\b/;
/** The same words as figures of speech: "nods the bill through", "wiping out", "into the hands of his creditors", "on the other hand", "shed light on", "a blind eye". */
const IDIOM = /\b(?:(?:nods?|nodding) (?:[\w']+ ){0,3}through|(?:wipes?|wiping) out|(?:drums?|drumming) up|(?:taps?|tapping) into|(?:shrugs?|shrugging) off|(?:into|out of|at) the hands of|(?:into|in) (?:other|safe|private) hands|(?:change[sd]?|changing) hands|on the (?:one|other) hand|the upper hand|in light of|(?:came|comes|come|brought|brings|bring) to light|(?:sheds?|shedding|throws?|threw|casts?|casting) (?:new |fresh |some |little |more )?light on|a blind eye)\b/g;
/** Talk of the picture itself: "Here we see…", "you can see the cracks", "On screen,", "in this engraving" — not "you can see why", "in the registers we see", "the first film on screen". */
const PICTURE_TALK = /^(?:here|now) we (?:can )?see\b|\byou can (?:still )?see (?!(?:why|how|that|what|whether|who|where|when|if)\b)|^on screen\b|\bin this (?:painting|picture|image|photograph|engraving|map|shot)\b|\bas we (?:look|watch)\b/;
/** "We see…" opening a sentence: the picture, unless what follows informs ("We see the same name in the records of 1640"). */
const WE_SEE = /^we (?:can )?see\b/;
const INFORMATIVE = /\d|\b(?:because|so that|which meant|that meant|cost|price|paid|worth|owed|law|court|contract|record|records|ledger|accounts?)\b/;

/** A sentence that describes what the picture shows rather than adding what it cannot. */
export function describesPicture(sentence: string, visual?: NarrationBlock['visual']): boolean {
  const s = normalize(sentence);
  if (PICTURE_TALK.test(s)) return true;
  const words = wordTokens(s);
  const literal = s.replace(IDIOM, ' ');
  if (!INFORMATIVE.test(s) && (WE_SEE.test(s) || (GESTURE.test(literal) && (SEEN.test(literal) || words.length <= 8)) || (AMBIENT.test(literal) && SEEN.test(literal)))) return true;
  // Narration that repeats the block's own visual direction word for word. Names and figures do not count: the fact and the picture of it share its people, places and years.
  if (visual) {
    const texts = [visual.note, ...visual.mustShow.map((m) => m.detail)];
    const names = properNouns([sentence, ...texts]);
    const telling = (ws: readonly string[]) => ws.filter((w) => w.length > 3 && !/\d/.test(w) && !names.has(w));
    const shown = new Set(telling(wordTokens(texts.join(' '))));
    const mine = telling(words);
    if (shown.size >= 4 && mine.length >= 4 && mine.filter((w) => shown.has(w)).length / mine.length >= 0.7) return true;
  }
  return false;
}

/** The words texts capitalise other than at the start of a sentence (as word tokens): their names. */
function properNouns(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts)
    for (const s of sentencesOf(t)) (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).forEach((w, i) => i > 0 && /^\p{Lu}/u.test(w) && wordTokens(w).forEach((x) => out.add(x)));
  return out;
}

const CONTRAST_ONE = /\bnot (?:just |only |simply |merely )?(?:a |an |the |about )?[\w' -]{1,30},? but\b/;
/** "It wasn't…", "It is not…", and the contracted "It's not…", "They're not…". */
const NEGATED = /^(?:it|this|that|he|she|they|what [\w' ]{1,30})(?:\s+(?:(?:was|is|were|are)\s*n'?o?t|(?:was|is|were|are) not|did not|didn'?t)|'(?:s|re) not)\b/;
/** "Salt wasn't just a seasoning.", "The bridge was not a success.": a named subject denied a kind of thing. */
const NEGATED_NAMED = /^(?!there |here )[\w'-]+(?: [\w'-]+){0,3} (?:was|is|were|are)(?:n'?t| not) (?:just |only |simply |merely )?(?:a|an|about)\b/;
const negated = (s: string) => NEGATED.test(s) || NEGATED_NAMED.test(s);
const AFFIRMED = /^(?:it|this|that|he|she|they)(?:'s|'re| was| is| were| are)\b/;
/**
 * "It is not known whether…", "It was not clear who…", "It is not recorded.": a
 * hedge about the record, not the "It wasn't X. It was Y." formula — which
 * "It wasn't known for its silver. It was known for its herring." still is.
 */
const NOT_KNOWN = /(?:\bnot|n't) (?:entirely |altogether |yet |fully )?(?:known|clear|certain|sure|obvious|recorded|documented)(?:\s*(?:[.,;:-]|$)| (?:that|to (?:have|be))\b|(?: [\w']+){0,4}? (?:whether|if|who|whom|whose|what|which|why|how|when|where)\b)/;
/** "It wasn't X. It was Y.": a denial that is no hedge, answered by an affirmation that is no denial. */
const formula = (denied: string, affirmed: string) => negated(denied) && !NOT_KNOWN.test(denied) && AFFIRMED.test(affirmed) && !negated(affirmed);
/** The formula's two sentences joined by a dash or a semicolon: "It wasn't greed — it was fear." */
const JOINED = /^(.+?)\s*[-;]\s*((?:it|this|that|he|she|they)(?:'s|'re| was| is| were| are)\b.*)$/;

/**
 * Every AI-pattern signal of the narration, in order. A pattern that only
 * matters when it piles up is reported everywhere it occurs; `summarise`
 * says which patterns are over their threshold.
 */
export function aiSignals(blocks: readonly NarrationBlock[]): AiSignal[] {
  const out: AiSignal[] = [];
  const add = (pattern: AiPattern, ref: string, excerpt: string, kind: 'HARD' | 'DENSITY') => out.push({ pattern, ref, excerpt: clip(excerpt), kind });
  const narration = narrationOnly(blocks);
  for (const b of narration) {
    const raw = maskQuotes(b.text);
    for (const p of stockPhrases(b.text)) add('stock_phrase', b.key, p, 'HARD');
    const ss = sentencesOf(b.text);
    ss.forEach((s, i) => {
      const n = normalize(s);
      // One signal per pattern per sentence, however many of its rules match (HARD rules come first).
      const found = new Set<AiPattern>();
      for (const r of SENTENCE_RULES) {
        if (found.has(r.pattern) || !r.re.test(n)) continue;
        found.add(r.pattern);
        add(r.pattern, b.key, s, r.kind);
      }
      const joined = JOINED.exec(n);
      const contrast = CONTRAST_ONE.test(n) || (joined !== null && formula(joined[1]!, joined[2]!));
      if (contrast) add('contrast_formula', b.key, s, 'DENSITY');
      const next = ss[i + 1];
      // "It wasn't X. It was Y." — counted once: not again after a contrast in one sentence, not when the next sentence is itself a negation, and never for a hedge.
      if (next && !contrast && formula(n, normalize(next))) add('contrast_formula', b.key, `${s} ${next}`, 'DENSITY');
      if (next && n.endsWith('?') && countWords(s) <= 6 && countWords(next) <= 4) add('qa_pair', b.key, `${s} ${next}`, 'DENSITY');
      if (describesPicture(s, b.visual)) add('visual_description', b.key, s, 'HARD');
    });
    const last = ss.at(-1);
    if (last && MICRO_HOOK.some((re) => re.test(normalize(last)))) add('micro_hook', b.key, last, 'HARD');
    // Em-dashes standing in for sentences (two or more in a block).
    const dashes = (raw.match(/—|\s–\s|\s--\s/g) ?? []).length;
    if (dashes >= 2) add('em_dash', b.key, `${dashes} dashes`, 'DENSITY');
    // Figures of speech close together.
    const figures = (normalize(raw).match(/\b(?:like a|like an|as if|as though|a sea of|a wave of|a storm of|a web of|a flood of|a tide of|a mountain of|a fever of)\b/g) ?? []).length;
    if (figures >= 2) add('metaphor_stack', b.key, `${figures} figures of speech`, 'DENSITY');
  }
  sequenceSignals(narratorSentences(blocks), add);
  endingSignals(narration, add);
  return out;
}

/** Runs across sentences: fragments, questions, same-length sentences. */
function sequenceSignals(all: readonly Sentence[], add: (p: AiPattern, ref: string, excerpt: string, kind: 'HARD' | 'DENSITY') => void): void {
  let frag: Sentence[] = [];
  let questions: Sentence[] = [];
  let run: Sentence[] = [];
  const flushFrag = () => {
    if (frag.length >= 3) add('fragment_run', frag.at(-1)!.block, frag.map((s) => s.text).join(' '), 'DENSITY');
    frag = [];
  };
  const flushQuestions = () => {
    if (questions.length >= 2) add('rhetorical_question', questions.at(-1)!.block, questions.map((s) => s.text).join(' '), 'HARD');
    questions = [];
  };
  const flushRun = () => {
    if (run.length >= 4) add('length_repetition', run.at(-1)!.block, `${run.length} sentences of about ${run[0]!.words} words`, 'DENSITY');
    run = [];
  };
  let section = all[0]?.section;
  for (const s of all) {
    if (s.section !== section) {
      flushFrag();
      flushQuestions();
      flushRun();
      section = s.section;
    }
    if (isFragment(s)) frag.push(s);
    else flushFrag();
    if (s.text.trim().endsWith('?')) {
      questions.push(s);
      add('rhetorical_question', s.block, s.text, 'DENSITY');
    } else flushQuestions();
    if (s.words >= 5 && run.length && Math.abs(s.words - run[0]!.words) <= 2) run.push(s);
    else {
      flushRun();
      if (s.words >= 5) run = [s];
    }
  }
  flushFrag();
  flushQuestions();
  flushRun();
}

/** Blocks that end the way the block before them ended: a short fragment again and again, or the same last word. */
function endingSignals(narration: readonly NarrationBlock[], add: (p: AiPattern, ref: string, excerpt: string, kind: 'HARD' | 'DENSITY') => void): void {
  let streak = 0;
  let prev: ReturnType<typeof blockEnding> | null = null;
  for (const b of narration) {
    const cur = blockEnding(b.text);
    const same = prev !== null && ((prev.short && cur.short) || (cur.word.length > 3 && cur.word === prev.word));
    streak = same ? streak + 1 : 0;
    if (streak >= 2) add('repeated_ending', b.key, cur.last, 'DENSITY');
    prev = cur;
  }
}

/** A text without its parenthetical asides (an aside is not how a block ends). */
export const withoutAsides = (text: string) => text.replace(/\s*\([^)]*\)/g, '');

/** A sentence of one to three words — not a quotation with its attribution, which only looks short ("…," he wrote.). */
export const isFragment = (s: Pick<Sentence, 'text' | 'words'>) => s.words > 0 && s.words <= 3 && !quotes(s.text);

/** How a block ends: its last sentence, whether that is short, and its last word — none when a quotation closes it (the record's words, not the narrator's). */
export function blockEnding(text: string): { last: string; short: boolean; word: string } {
  const last = sentencesOf(withoutAsides(text)).at(-1) ?? '';
  const words = wordTokens(last);
  return { last, short: words.length > 0 && words.length <= 4 && !quotes(last), word: /"…"\W*$/.test(last) ? '' : (words.at(-1) ?? '') };
}

/** When a DENSITY pattern warns: its count against the script's length (words). */
const THRESHOLD: Partial<Record<AiPattern, (n: number, words: number, minutes: number) => boolean>> = {
  contrast_formula: (n, words) => n >= 2 && n > words / 500,
  qa_pair: (n) => n >= 2,
  fragment_run: (n) => n >= 2,
  em_dash: (n, words) => n >= 3 && n > words / 400,
  metaphor_stack: (n) => n >= 2,
  rhetorical_question: (n, _w, minutes) => n > Math.max(1, minutes),
  repeated_ending: (n) => n >= 2,
  length_repetition: (n) => n >= 2,
  truth_reveal: (n) => n >= 2,
  imagine_opener: (n) => n >= 2,
};

/** The signals an editor should act on: every HARD one, and DENSITY ones of patterns over their threshold. */
export function actionable(signals: readonly AiSignal[], words: number): AiSignal[] {
  const over = new Set(overThreshold(signals, words));
  return signals.filter((s) => s.kind === 'HARD' || over.has(s.pattern));
}

export function overThreshold(signals: readonly AiSignal[], words: number): AiPattern[] {
  const minutes = Math.max(words / SCRIPT_TIMING.wordsPerMinute, 1);
  return AI_PATTERNS.filter((p) => {
    const hard = signals.some((s) => s.pattern === p && s.kind === 'HARD');
    const n = signals.filter((s) => s.pattern === p && s.kind === 'DENSITY').length;
    return hard || (n > 0 && (THRESHOLD[p]?.(n, words, minutes) ?? false));
  });
}

/**
 * The fingerprint of a script: a 0–100 risk (0 = nothing machine-like found).
 * HARD signals weigh three times a DENSITY one; DENSITY signals count only
 * past their threshold. A heuristic indicator for the editor — not a detector
 * of who wrote the text.
 */
export function summarise(blocks: readonly NarrationBlock[], signals: readonly AiSignal[] = aiSignals(blocks)): FingerprintSummary {
  const words = narrationOnly(blocks).reduce((n, b) => n + countWords(maskQuotes(b.text)), 0);
  const sentenceCount = Math.max(narratorSentences(blocks).length, 1);
  const over = overThreshold(signals, words);
  const counted = signals.filter((s) => s.kind === 'HARD' || over.includes(s.pattern));
  const weight = counted.reduce((n, s) => n + (s.kind === 'HARD' ? 3 : 1), 0);
  const perPattern: Partial<Record<AiPattern, number>> = {};
  for (const s of signals) perPattern[s.pattern] = (perPattern[s.pattern] ?? 0) + 1;
  return { score: Math.min(100, Math.round((100 * weight) / (sentenceCount * 1.5))), words, signals: counted.length, perPattern, overThreshold: over };
}

/** Patterns that touch one block (for a change: what it removed, what it added). */
export function blockPatterns(block: NarrationBlock): AiPattern[] {
  return [...new Set(aiSignals([block]).map((s) => s.pattern))].sort();
}
