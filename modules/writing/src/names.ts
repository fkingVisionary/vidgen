import type { NameEntry, NameKind, Pronunciation } from '@docengine/core';
import { nameTokens, normalize, wordTokens } from '@docengine/story/shared';
import { maskQuotes, narrationOnly, type NarrationBlock } from './text.ts';

/**
 * Names in four layers. The historical name is the evidence's spelling and is
 * never westernised; the display name is what the narration writes (and what
 * subtitles, citations and on-screen text will write); the spoken form comes
 * from the pronunciation notes — this module flags names a narrator may say
 * wrong, it never guesses phonemes; the voice engine's approved lexicon stays
 * the authority on how a name is said.
 */

export interface KnownName {
  name: string;
  kind: NameKind;
  castId: string | null;
  fictional: boolean;
  claimKeys: readonly string[];
}

/** Spellings English readers stumble over: letter pairs English rarely uses, accents, and name particles. */
const FOREIGN = /ij|aa|uu|sch|tj|cz|sz|rz|zs|oe|ae|uy|[^\x00-\x7F]/i;
const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'ter', 'ten', 'di', 'da', 'del', 'della', 'le', 'la', 'du', 'al', 'ibn', 'bin']);

/** Why a narrator might say a name wrong (empty: no reason to think so). */
export function pronunciationRisk(name: string): string[] {
  const out: string[] = [];
  const foreign = name.match(FOREIGN);
  if (foreign) out.push(/[^\x00-\x7F]/.test(foreign[0]) ? 'accented letters' : `the spelling "${foreign[0].toLowerCase()}"`);
  if (wordTokens(name).some((w) => PARTICLES.has(w)) && name.split(/\s+/).length > 1) out.push('a name particle');
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The form of a name a text uses: the full name if it is there, else the words of it that are. */
function formIn(text: string, name: string): string | null {
  const full = new RegExp(`\\b${escape(name)}\\b`, 'u').exec(text);
  if (full) return full[0];
  const tokens = nameTokens(name);
  const words = name.split(/\s+/).filter((w) => tokens.includes(normalize(w).replace(/[^a-z0-9]/g, '')));
  const found = words.filter((w) => new RegExp(`\\b${escape(w)}\\b`, 'u').test(text));
  return found.length ? found.join(' ') : null;
}

const noteFor = (notes: readonly Pronunciation[], forms: readonly string[]) => {
  const keys = new Set(forms.map((f) => normalize(f)));
  return notes.find((p) => keys.has(normalize(p.term))) ?? null;
};

/**
 * The name layer of a script: every known name (cast, key figures) the
 * narration uses, and any other proper name it writes, with its four layers
 * and whether it needs a pronunciation decision.
 */
export function nameLayer(args: { known: readonly KnownName[]; blocks: readonly NarrationBlock[]; pronunciations: readonly Pronunciation[]; otherNames?: readonly { form: string; refs: readonly string[] }[] }): NameEntry[] {
  const narration = narrationOnly(args.blocks);
  const out: NameEntry[] = [];
  const claimed = new Set<string>();
  for (const k of args.known) {
    const tokens = nameTokens(k.name);
    if (!tokens.length) continue;
    const refs: string[] = [];
    let display: string | null = null;
    for (const b of args.blocks) {
      // A cast member's own lines carry their name in subtitles and labels, even where the narration does not say it.
      if (b.speakerId) {
        if (k.castId && b.speakerId === k.castId) refs.push(b.key);
        continue;
      }
      const text = maskQuotes(b.text);
      const words = new Set(wordTokens(text));
      if (!tokens.some((t) => words.has(t))) continue;
      refs.push(b.key);
      display ??= formIn(text, k.name);
    }
    if (!refs.length) continue;
    for (const t of tokens) claimed.add(t);
    const note = noteFor(args.pronunciations, [k.name, display ?? '', ...k.name.split(/\s+/)].filter(Boolean));
    out.push(entry(`N${out.length + 1}`, k.kind, k.castId, k.fictional, k.name, display ?? k.name, refs, k.claimKeys, note));
  }
  for (const o of args.otherNames ?? []) {
    const tokens = nameTokens(o.form);
    if (!tokens.length || tokens.every((t) => claimed.has(t))) continue;
    for (const t of tokens) claimed.add(t);
    const note = noteFor(args.pronunciations, [o.form, ...o.form.split(/\s+/)]);
    out.push(entry(`N${out.length + 1}`, 'TERM', null, false, o.form, o.form, [...o.refs], [], note));
  }
  return out;
}

function entry(id: string, kind: NameKind, castId: string | null, fictional: boolean, historical: string, display: string, refs: string[], claimKeys: readonly string[], note: Pronunciation | null): NameEntry {
  const risk = pronunciationRisk(historical);
  const reasons: string[] = [];
  if (note?.needsReview) reasons.push(`its pronunciation note is ${note.confidence.toLowerCase()} confidence and not yet confirmed`);
  else if (!note && risk.length) reasons.push(`${risk.join(' and ')}, and no pronunciation note`);
  if (normalize(display) !== normalize(historical) && !nameTokens(display).every((t) => nameTokens(historical).includes(t))) reasons.push(`the narration writes "${display}", the evidence "${historical}"`);
  return {
    id,
    kind,
    castId,
    fictional,
    historicalName: historical,
    displayName: display,
    spokenForm: note?.respelling || null,
    pronunciation: note ? { respelling: note.respelling, ipa: note.ipa, language: note.language, confidence: note.confidence, needsReview: note.needsReview, source: note.source } : null,
    mentions: refs.length,
    firstRef: refs[0] ?? null,
    claimKeys: [...claimKeys],
    candidate: reasons.length > 0,
    candidateReasons: reasons,
  };
}

/**
 * A name changed between two wordings of a block: a name the first used is
 * gone and the second uses a near-spelling of it ("Hendrik" → "Henry"), or
 * the second spells a known name differently. Dropping a name for a pronoun
 * is not a change of identity.
 */
export function namesAltered(before: string, after: string, known: readonly KnownName[]): string[] {
  const a = new Set(wordTokens(maskQuotes(before)));
  const b = new Set(wordTokens(maskQuotes(after)));
  const caps = (t: string) => new Set([...maskQuotes(t).matchAll(/\b\p{Lu}[\p{L}'’-]{2,}/gu)].map((m) => normalize(m[0]).replace(/['’-]/g, '')));
  const newCaps = [...caps(after)].filter((w) => !caps(before).has(w) && !a.has(w));
  const out: string[] = [];
  for (const k of known) {
    for (const t of nameTokens(k.name)) {
      if (!a.has(t) || b.has(t)) continue;
      const near = newCaps.find((w) => similar(w, t));
      if (near) out.push(`"${t}" became "${near}"`);
    }
  }
  return out;
}

/** Two spellings of one name: same first letter and within a third of their length in edits, rounded up ("Hendrik" → "Henry" is three). */
function similar(a: string, b: string): boolean {
  if (a === b || a[0] !== b[0]) return false;
  const d = distance(a, b);
  return d <= Math.max(2, Math.ceil(Math.max(a.length, b.length) / 3));
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}
