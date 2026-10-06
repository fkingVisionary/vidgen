import { EARLIER_PERFORMANCE_RULES, type PerformanceCheck, type PerformanceMark, type PerformanceRules, type PerformanceStrategy, type ScriptBlockClass, type SpokenForm } from '@docengine/core';
import { stripMarkup, type RenderedNarration, type VoiceModelCapabilities } from '@docengine/providers';
import { inForceAt, isHouseDirection, isPlainDelivery, isReset, type PreparedSentence } from './performance.ts';
import { applyForms } from './spoken.ts';
import { countWords, wordList, type TextSpan } from './text.ts';

/**
 * Deterministic checks of a take's performance text, run before anything is
 * sent (a FAIL means the take is not sent). They prove the derived text says
 * exactly the script's words: no word added, dropped or changed, every
 * spoken form recorded, directions only between sentences and never inside
 * a quotation, directions in plain words and pauses in the model's own
 * markup, within the strategy's density.
 */

export interface TakeCheckInput {
  canonical: string;
  forms: readonly SpokenForm[];
  spoken: string;
  /** Each sentence's range in the spoken text. */
  spokenSentences: readonly TextSpan[];
  rendered: RenderedNarration;
  marks: readonly PerformanceMark[];
  sentences: readonly PreparedSentence[];
  strategy: PerformanceStrategy;
  director: boolean;
  /** The model's markup: what it would read aloud or reject is never sent. */
  caps: Pick<VoiceModelCapabilities, 'directions' | 'pauses'>;
  /** The take's performance rules: the density limits, the reset and the heightened feeling (default EARLIER_PERFORMANCE_RULES). */
  rules?: PerformanceRules;
}

const DESCRIPTOR = /^[a-z][a-z \-']*[a-z]$/;
const PAUSE_TAGS = new Set(['[pause]', '[long pause]']);
const BREAK = /^<break time="\d+(?:\.\d+)?s" \/>$/;
/** Classes whose delivery stays measured: told with their uncertainty, or declared as reconstruction or fiction. */
const MEASURED: ReadonlySet<ScriptBlockClass> = new Set(['UNCERTAIN', 'RECONSTRUCTION', 'FICTION']);
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** "more than one in ten words" (small numbers in words). */
const moreThanOneIn = (words: number) => (words === 1 ? 'more than one a word' : `more than one in ${SMALL[words] ?? words} words`);

function firstDifference(a: readonly string[], b: readonly string[]): string {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `word ${i + 1}: "${a[i] ?? '(none)'}" where the script has "${b[i] ?? '(none)'}"`;
  }
  return 'same words';
}

/** Ranges inside quotation marks (straight or curly). */
function quoteRanges(text: string): TextSpan[] {
  const out: TextSpan[] = [];
  for (const m of text.matchAll(/“[^”]*”|"[^"]*"/g)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

export function checkTake(t: TakeCheckInput): PerformanceCheck[] {
  const rules = t.rules ?? EARLIER_PERFORMANCE_RULES;
  const checks: PerformanceCheck[] = [];
  const add = (id: string, label: string, status: PerformanceCheck['status'], detail: string) => checks.push({ id, label, status, detail });

  // 1. The spoken text is the canonical text with its recorded spoken forms, and nothing else.
  let rebuilt: string | null = null;
  try {
    rebuilt = applyForms(t.canonical, t.forms);
  } catch (err) {
    add('spoken-forms', 'Spoken forms recorded', 'FAIL', err instanceof Error ? err.message : String(err));
  }
  if (rebuilt !== null) {
    if (rebuilt === t.spoken) add('spoken-forms', 'Spoken forms recorded', 'PASS', t.forms.length ? `${t.forms.length} spoken form(s), each recorded against the script's text` : 'no spoken forms: the words are the script\'s');
    else add('spoken-forms', 'Spoken forms recorded', 'FAIL', 'the spoken text differs from the script in a place no spoken form records');
  }

  // 2. Same words as the spoken text: nothing added, deleted or changed by the markup.
  const sent = wordList(stripMarkup(t.rendered));
  const spoken = wordList(t.spoken);
  if (sent.join(' ') === spoken.join(' ')) add('words', 'Words unchanged', 'PASS', `${spoken.length} word(s), in order`);
  else add('words', 'Words unchanged', 'FAIL', firstDifference(sent, spoken));

  // 3. Every sentence is in the sent text verbatim.
  const verbatim = t.spokenSentences.every((s, i) => {
    const r = t.rendered.segments[i];
    return !!r && t.rendered.text.slice(r.start, r.end).toLowerCase() === t.spoken.slice(s.start, s.end).toLowerCase();
  });
  if (verbatim && t.rendered.segments.length === t.spokenSentences.length) add('sentences', 'Sentences verbatim', 'PASS', `${t.spokenSentences.length} sentence(s)`);
  else add('sentences', 'Sentences verbatim', 'FAIL', 'a sentence was altered or is missing from the sent text');

  // 4. Directions only before a sentence, pauses only between sentences.
  const starts = new Set(t.rendered.segments.map((s) => s.start));
  const ends = new Set(t.rendered.segments.map((s) => s.end));
  const misplaced: string[] = [];
  for (const m of t.rendered.markup) {
    const piece = t.rendered.text.slice(m.start, m.end);
    if (m.kind === 'DIRECTION') {
      let j = m.end;
      while (j < t.rendered.text.length && /\s/.test(t.rendered.text[j]!)) j++;
      const nextMarkup = t.rendered.markup.find((x) => x.start === j && x.kind === 'DIRECTION');
      if (!starts.has(j) && !nextMarkup) misplaced.push(piece);
    } else {
      let j = m.start;
      while (j > 0 && /\s/.test(t.rendered.text[j - 1]!)) j--;
      if (!ends.has(j)) misplaced.push(piece);
    }
  }
  add('boundaries', 'Directions at sentence boundaries', misplaced.length ? 'FAIL' : 'PASS', misplaced.length ? `misplaced: ${misplaced.join(', ')}` : `${t.rendered.markup.length} piece(s) of markup, all between sentences`);

  // 5. Never inside a quotation.
  const quotes = quoteRanges(t.rendered.text);
  const inQuote = t.rendered.markup.filter((m) => quotes.some((q) => m.start > q.start && m.start < q.end));
  add('quotations', 'Quotations untouched', inQuote.length ? 'FAIL' : 'PASS', inQuote.length ? `markup inside a quotation: ${inQuote.map((m) => t.rendered.text.slice(m.start, m.end)).join(', ')}` : quotes.length ? `${quotes.length} quotation(s) left as written` : 'no quotations');

  // 6. Directions are plain words (no invented dialogue, numbers or names in the markup).
  const bad: string[] = [];
  for (const m of t.rendered.markup) {
    const piece = t.rendered.text.slice(m.start, m.end);
    if (m.kind === 'PAUSE') {
      if (!PAUSE_TAGS.has(piece) && !BREAK.test(piece)) bad.push(piece);
      continue;
    }
    const inner = piece.replace(/^\[|\]$/g, '');
    const words = inner.split(', ');
    if (!piece.startsWith('[') || !piece.endsWith(']') || words.length > 3 || words.some((w) => !DESCRIPTOR.test(w) || w.split(' ').length > 3)) bad.push(piece);
  }
  add('vocabulary', 'Directions in plain words', bad.length ? 'FAIL' : 'PASS', bad.length ? `not a plain direction: ${bad.join(', ')}` : 'every direction is a few plain words');

  // 7. Only markup the model takes: SSML breaks for a model that reads SSML, audio tags for one that takes tags.
  const foreign: string[] = [];
  for (const m of t.rendered.markup) {
    const piece = t.rendered.text.slice(m.start, m.end);
    const ok = m.kind === 'DIRECTION' ? t.caps.directions : BREAK.test(piece) ? t.caps.pauses === 'BREAKS' : t.caps.pauses === 'TAGS';
    if (!ok) foreign.push(piece);
  }
  const mode = t.caps.pauses === 'TAGS' ? 'audio tags' : t.caps.pauses === 'BREAKS' ? 'SSML breaks' : 'punctuation only';
  add('markup', 'Markup the model takes', foreign.length ? 'FAIL' : 'PASS', foreign.length ? `the model would read or reject: ${foreign.join(', ')} (it takes ${mode})` : `pauses as ${mode}${t.caps.directions ? ', directions as tags' : ''}`);

  // 8. Density, by strategy. The house limits hold for what the strategy translates from the script; an expressive take adds one moment; the director's directions only warn when they crowd the chunk.
  const directions = t.rendered.markup.filter((m) => m.kind === 'DIRECTION').length;
  const words = countWords(t.spoken);
  const house = t.marks.filter((m) => m.source === 'SCRIPT');
  const moments = t.marks.filter((m) => m.source === 'STRATEGY' && !isHouseDirection(m, t.sentences, rules));
  const per = rules.directorWordsPerMark;
  const crowded = t.director && directions * per > Math.max(words, per);
  const director = t.director ? `; ${t.marks.filter((m) => m.source === 'DIRECTOR').length} of them the director's${crowded ? `, ${moreThanOneIn(per)}` : ''}` : '';
  if (t.strategy === 'PLAIN') {
    const strategyMarks = t.marks.filter((m) => m.source !== 'DIRECTOR').length;
    const own = t.director ? strategyMarks : Math.max(strategyMarks, directions);
    add('density', 'Direction density', own ? 'FAIL' : crowded ? 'WARN' : 'PASS', own ? `${own} direction(s) in a plain take` : `no directions of its own (plain)${director}`);
  } else if (t.strategy === 'RESTRAINED' || t.strategy === 'EXPRESSIVE') {
    const tooClose = house.some((m, i) => i > 0 && !isReset(m.intent, rules) && wordsBetween(t.sentences, house[i - 1]!.sentence, m.sentence) < rules.minWordsBetweenMarks);
    const allowed = t.strategy === 'EXPRESSIVE' ? 1 : 0;
    const over = house.length > rules.maxMarksPerChunk || tooClose || moments.length > allowed;
    const limits = `house style: at most ${rules.maxMarksPerChunk}, ${rules.minWordsBetweenMarks}+ words apart${allowed ? `, plus ${allowed} expressive moment` : ''}`;
    add('density', 'Direction density', over ? 'FAIL' : crowded ? 'WARN' : 'PASS', `${t.marks.length} direction(s) in ${words} words (${limits})${director}`);
  } else {
    add('density', 'Direction density', 'WARN', `over-directed (comparison only): ${directions} direction(s) in ${words} words${director}`);
  }

  // 9. No emotion manufactured where the script marks plain narration.
  const manufactured = t.marks.filter((m) => m.source === 'STRATEGY' && !!m.intent.emotion && isPlainDelivery(t.sentences[m.sentence]!.delivery));
  add('restraint', 'No manufactured emotion', manufactured.length ? 'WARN' : 'PASS', manufactured.length ? `${manufactured.length} direction(s) on narration the script marks as plain` : 'directions only where the script asks for a delivery');

  // 10. Measured delivery where the script is uncertain, reconstructed or fictional (it must not sound like documented fact, or like drama) — under the direction in force there, which carries forward. Heightened: the rules' excited word, or over-direction's "dramatic".
  const loud = new Set([rules.emotionWords.EXCITED, 'dramatic'].filter((w): w is string => !!w));
  const heightened = t.sentences.flatMap((s, i) => {
    const m = inForceAt(t.marks, i);
    if (!m || !MEASURED.has(s.infoClass) || (m.intent.intensity === 'LOW' && !loud.has(m.intent.emotion ?? ''))) return [];
    const said = [m.intent.emotion, m.intent.delivery].filter(Boolean).join(', ');
    return [`sentence ${i + 1} (${s.infoClass.toLowerCase()}): ${said}${m.intent.intensity !== 'LOW' ? `, ${m.intent.intensity.toLowerCase()} intensity` : ''}${m.sentence !== i ? ` (carried from sentence ${m.sentence + 1})` : ''}`];
  });
  if (heightened.length) add('info-class', 'Delivery fits the information class', 'WARN', heightened.join('; '));

  // 11. A forward slash may be read as inline phonemes by a model that takes audio tags.
  const slashes = t.caps.directions ? (stripMarkup(t.rendered).match(/\//g) ?? []).length : 0;
  if (slashes) add('slashes', 'No inline phonemes', 'WARN', `${slashes} forward slash(es) in the sent text: the model may read the text between two slashes as phonemes`);

  // 12. What the model cannot take is reported, not sent.
  if (t.rendered.unsupported.length) add('unsupported', 'Not expressible by the model', 'WARN', t.rendered.unsupported.join('; '));
  return checks;
}

function wordsBetween(sentences: readonly PreparedSentence[], from: number, to: number): number {
  return sentences.slice(from, to).reduce((n, s) => n + countWords(s.text), 0);
}

export const checksPassed = (checks: readonly PerformanceCheck[]) => checks.every((c) => c.status !== 'FAIL');
