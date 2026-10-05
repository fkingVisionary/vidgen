import type { Pronunciation, PronunciationMethod, PronunciationStatus, PronunciationTermKind } from '@docengine/core';
import type { PronunciationRule } from '@docengine/providers';
import type { AliasRule } from './spoken.ts';
import { sentenceSpans } from './text.ts';

/**
 * The pronunciation review list: names, places, foreign words, terms and
 * abbreviations in the narration, and how each is said. It starts from the
 * script's own pronunciation notes and adds what the narration contains that
 * a voice is likely to get wrong (foreign spellings, accents, all-capital
 * abbreviations). Nothing is assumed right: a term is PENDING until the
 * editor approves the voice's own reading, an alias, or phonemes. Approved
 * aliases are spoken in place of the term; approved phonemes go to the
 * provider's pronunciation dictionary; the script keeps its spelling.
 */

export interface DetectedTerm {
  term: string;
  kind: PronunciationTermKind;
  /** Why it is on the list. */
  reason: string;
}

/** Spellings an English voice often misreads (Dutch, German, French, Latin…). */
const FOREIGN = /aa|ij|oe|ui|uy|sch|eeu|ieu|zw|ae|cz|sz|ğ|ø|å|æ|œ|ß|[à-öù-ÿ]/i;
const NAME_PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'ten', 'ter', 'la', 'le', 'du', 'des', 'di', 'da']);
const COMMON = new Set(['I', 'A', 'OK', 'TV', 'UK', 'US', 'USA', 'AD', 'BC', 'CE', 'BCE']);

/** Words that open sentences and are capitalised only for that reason. */
const OPENERS = new Set('a an the in on at by of for from to with after before when while then but and so as if it its this that these those there here he she they we you i his her their our one most many some no not'.split(' '));

/** Capitalised runs ("Jan van Goyen"), broken at punctuation, without a sentence's capitalised first word. */
function capitalisedRuns(text: string): { run: string; sentenceStart: boolean }[] {
  const out: { run: string; sentenceStart: boolean }[] = [];
  for (const s of sentenceSpans(text)) {
    const sentence = text.slice(s.start, s.end);
    let run: string[] = [];
    let startsSentence = false;
    let lastEnd = 0;
    const flush = () => {
      while (run.length && NAME_PARTICLES.has(run.at(-1)!.toLowerCase())) run.pop();
      if (run.length) out.push({ run: run.join(' '), sentenceStart: startsSentence });
      run = [];
    };
    [...sentence.matchAll(/[\p{L}][\p{L}'’\-]*/gu)].forEach((m, i) => {
      // Punctuation between two words ends a run ("In Haarlem, Jan").
      if (/[^\s]/u.test(sentence.slice(lastEnd, m.index))) flush();
      lastEnd = m.index + m[0].length;
      const w = m[0].replace(/['’]s$/u, '');
      if (i === 0 && OPENERS.has(w.toLowerCase())) return;
      const capital = /^\p{Lu}/u.test(w);
      if (capital || (run.length && NAME_PARTICLES.has(w.toLowerCase()))) {
        if (!run.length) startsSentence = i === 0;
        run.push(w);
      } else flush();
    });
    flush();
  }
  return out;
}

/** Terms in the narration worth checking before generation. */
export function detectTerms(text: string): DetectedTerm[] {
  const found = new Map<string, DetectedTerm>();
  for (const m of text.matchAll(/\b[A-Z]{2,6}\b/g)) {
    if (!COMMON.has(m[0])) found.set(m[0], { term: m[0], kind: 'ABBREVIATION', reason: 'an abbreviation: spelled out or read as a word?' });
  }
  for (const { run, sentenceStart } of capitalisedRuns(text)) {
    const words = run.split(' ');
    const particle = words.length > 1 && words.some((w) => NAME_PARTICLES.has(w.toLowerCase()));
    // A single capitalised word at the start of a sentence is usually just the sentence's first word.
    if (sentenceStart && words.length === 1 && !FOREIGN.test(run)) continue;
    if (!particle && !FOREIGN.test(run) && !/[^\x00-\x7F]/.test(run)) continue;
    if (found.has(run)) continue;
    found.set(run, particle ? { term: run, kind: 'NAME', reason: 'a name with a particle (van, de…): which syllables are stressed?' } : { term: run, kind: 'FOREIGN', reason: 'a foreign spelling an English voice may misread' });
  }
  return [...found.values()];
}

export interface LexiconEntry {
  term: string;
  kind: PronunciationTermKind;
  method: PronunciationMethod;
  pronunciation: string | null;
  status: PronunciationStatus;
  source: 'SCRIPT' | 'DETECTED' | 'EDITOR';
  hint: string | null;
}

/** New entries for the list: the script's notes (confirmed by the editor, or pending) and detected terms. Existing entries are never overwritten. */
export function proposeEntries(text: string, notes: readonly Pronunciation[], existing: ReadonlySet<string>): LexiconEntry[] {
  const out = new Map<string, LexiconEntry>();
  for (const n of notes) {
    if (existing.has(n.term) || !text.includes(n.term)) continue;
    const confirmed = n.source === 'EDITOR' && !n.needsReview;
    out.set(n.term, {
      term: n.term,
      kind: /\s/.test(n.term) ? 'NAME' : 'FOREIGN',
      method: confirmed && n.ipa ? 'IPA' : 'DEFAULT',
      pronunciation: confirmed && n.ipa ? n.ipa : null,
      status: confirmed ? 'APPROVED' : 'PENDING',
      source: 'SCRIPT',
      hint: [n.respelling, n.ipa ? `/${n.ipa.replace(/^\/|\/$/g, '')}/` : null, n.language].filter(Boolean).join(' · ') || null,
    });
  }
  for (const d of detectTerms(text)) {
    if (existing.has(d.term) || out.has(d.term)) continue;
    out.set(d.term, { term: d.term, kind: d.kind, method: 'DEFAULT', pronunciation: null, status: 'PENDING', source: 'DETECTED', hint: d.reason });
  }
  return [...out.values()];
}

const present = (text: string, term: string) => new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(text);

/** The approved rules that apply to a text: aliases (spoken by the engine) and phonemes (applied by the provider). */
export function rulesFor(text: string, entries: readonly Pick<LexiconEntry, 'term' | 'method' | 'pronunciation' | 'status'>[]): { aliases: AliasRule[]; phonemes: PronunciationRule[] } {
  const aliases: AliasRule[] = [];
  const phonemes: PronunciationRule[] = [];
  for (const e of entries) {
    if (e.status !== 'APPROVED' || !e.pronunciation || !present(text, e.term)) continue;
    if (e.method === 'ALIAS') aliases.push({ term: e.term, alias: e.pronunciation });
    else if (e.method === 'IPA' || e.method === 'CMU') phonemes.push({ term: e.term, method: e.method, pronunciation: e.pronunciation });
  }
  return { aliases, phonemes };
}

/** Terms in a text still to be decided (pending, or heard wrong). */
export function unresolvedIn(text: string, entries: readonly Pick<LexiconEntry, 'term' | 'status'>[]): string[] {
  return entries.filter((e) => e.status !== 'APPROVED' && present(text, e.term)).map((e) => e.term);
}
