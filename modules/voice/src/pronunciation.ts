import type { Pronunciation, PronunciationConfig, PronunciationMethod, PronunciationStatus, PronunciationTermKind } from '@docengine/core';
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
 * provider's pronunciation dictionary; the script keeps its spelling. A
 * voice profile's own rules cover the terms the project has not approved.
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

const isParticle = (w: string) => NAME_PARTICLES.has(w.toLowerCase());
const capitalised = (w: string) => /^\p{Lu}/u.test(w);
/** A spelling an English voice may misread, or letters beyond ASCII. */
const looksForeign = (w: string) => FOREIGN.test(w) || /[^\x00-\x7F]/.test(w);
/** A word without a possessive "'s". */
const bare = (w: string) => w.replace(/['’]s$/u, '');

/**
 * Capitalised runs ("Jan van Goyen"), broken at punctuation, without a
 * sentence's capitalised first word. A run that opens a sentence loses its
 * first word when a capitalised name follows it ("Meet Thijs" is Thijs),
 * unless something says the word is part of the name: a foreign spelling
 * ("Thijs Gaergoedt"), a particle after it ("Jan van Goyen"), a particle
 * itself ("Van Goyen"), or the same word capitalised inside a sentence
 * elsewhere in the text. What is left is a run inside the sentence.
 */
function capitalisedRuns(text: string): { run: string; sentenceStart: boolean }[] {
  const out: { run: string; sentenceStart: boolean }[] = [];
  const sentences = sentenceSpans(text).map((s) => {
    const sentence = text.slice(s.start, s.end);
    return { sentence, words: [...sentence.matchAll(/[\p{L}][\p{L}'’\-]*/gu)] };
  });
  // Inside a sentence a capital says the word is a name.
  const inside = new Set(sentences.flatMap((s) => s.words.slice(1).map((m) => bare(m[0])).filter(capitalised)));
  for (const { sentence, words } of sentences) {
    let run: string[] = [];
    let startsSentence = false;
    let lastEnd = 0;
    const flush = () => {
      while (run.length && isParticle(run.at(-1)!)) run.pop();
      const [first, next] = run;
      if (startsSentence && first && next && capitalised(next) && !isParticle(next) && !isParticle(first) && !looksForeign(first) && !inside.has(first)) {
        run.shift();
        startsSentence = false;
      }
      if (run.length) out.push({ run: run.join(' '), sentenceStart: startsSentence });
      run = [];
    };
    words.forEach((m, i) => {
      // Punctuation between two words ends a run ("In Haarlem, Jan").
      if (/[^\s]/u.test(sentence.slice(lastEnd, m.index))) flush();
      lastEnd = m.index + m[0].length;
      const w = bare(m[0]);
      if (i === 0 && OPENERS.has(w.toLowerCase())) return;
      if (capitalised(w) || (run.length && isParticle(w))) {
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
    const particle = words.length > 1 && words.some(isParticle);
    // A single capitalised word at the start of a sentence is usually just the sentence's first word.
    if (sentenceStart && words.length === 1 && !FOREIGN.test(run)) continue;
    if (!particle && !looksForeign(run)) continue;
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
  /** An editor has saved it (a decision or a note): the detector no longer speaks for it. */
  edited: boolean;
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
      edited: false,
    });
  }
  for (const d of detectTerms(text)) {
    if (existing.has(d.term) || out.has(d.term)) continue;
    out.set(d.term, { term: d.term, kind: d.kind, method: 'DEFAULT', pronunciation: null, status: 'PENDING', source: 'DETECTED', hint: d.reason, edited: false });
  }
  return [...out.values()];
}

const present = (text: string, term: string) => new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(text);

type ProfileRule = PronunciationConfig['rules'][number];

/**
 * Entries the detector has replaced in this text: term → the term that
 * replaced it. Only an entry it listed itself that nobody has decided or
 * edited (DETECTED, PENDING, never edited), written in the text, which it no
 * longer finds there while it finds a term the entry ends with ("Meet Thijs"
 * → Thijs). Nothing is rewritten: such an entry is no longer to decide.
 */
export function withdrawnTerms(text: string, entries: readonly Pick<LexiconEntry, 'term' | 'source' | 'status' | 'edited'>[]): Map<string, string> {
  const out = new Map<string, string>();
  const listed = entries.filter((e) => e.source === 'DETECTED' && e.status === 'PENDING' && !e.edited);
  if (!listed.length) return out;
  const found = detectTerms(text).map((d) => d.term);
  for (const e of listed) {
    // An entry the text no longer has was not replaced: it is simply not in it.
    if (found.includes(e.term) || !present(text, e.term)) continue;
    // The longest it ends with: "Meet Pieter van Haarlem" is Pieter van Haarlem, though Haarlem is found too.
    const by = found.filter((t) => e.term.endsWith(` ${t}`)).sort((a, b) => b.length - a.length)[0];
    if (by) out.set(e.term, by);
  }
  return out;
}

/**
 * The rules that apply to a text: the project's approved entries, then the
 * profile's rules for terms the project has not approved (an approved term,
 * even read as the voice reads it, is the project's decision). Aliases are
 * spoken by the engine, phonemes applied by the provider.
 */
export function rulesFor(text: string, entries: readonly Pick<LexiconEntry, 'term' | 'method' | 'pronunciation' | 'status'>[], profileRules: readonly ProfileRule[] = []): { aliases: AliasRule[]; phonemes: PronunciationRule[] } {
  const aliases: AliasRule[] = [];
  const phonemes: PronunciationRule[] = [];
  const add = (term: string, method: PronunciationMethod, pronunciation: string) => {
    if (method === 'ALIAS') aliases.push({ term, alias: pronunciation });
    else if (method === 'IPA' || method === 'CMU') phonemes.push({ term, method, pronunciation });
  };
  for (const e of entries) {
    if (e.status !== 'APPROVED' || !e.pronunciation || !present(text, e.term)) continue;
    add(e.term, e.method, e.pronunciation);
  }
  const decided = new Set(entries.filter((e) => e.status === 'APPROVED').map((e) => e.term));
  for (const r of profileRules) {
    if (decided.has(r.term) || !present(text, r.term)) continue;
    decided.add(r.term); // a term's first rule
    add(r.term, r.method, r.pronunciation);
  }
  return { aliases, phonemes };
}

/**
 * Terms in a text still to be decided: pending or heard wrong, and neither
 * withdrawn by the detector nor, while pending, covered by one of the
 * profile's rules (heard wrong stays to decide).
 */
export function unresolvedIn(text: string, entries: readonly Pick<LexiconEntry, 'term' | 'status' | 'source' | 'edited'>[], profileRules: readonly ProfileRule[] = []): string[] {
  const withdrawn = withdrawnTerms(text, entries);
  const covered = new Set(profileRules.map((r) => r.term));
  return entries.filter((e) => e.status !== 'APPROVED' && !withdrawn.has(e.term) && !(e.status === 'PENDING' && covered.has(e.term)) && present(text, e.term)).map((e) => e.term);
}
