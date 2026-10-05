import type { ScriptTiming } from '@docengine/core';
import { sentences, wordTokens } from '@docengine/story/shared';
import { allBlocks, type DraftBlock, type DraftSection, type ScriptDraft } from './draft.ts';
import type { ScriptFinding } from './rules.ts';
import { fictionalCast, realCast, type ScriptScope } from './scope.ts';

/**
 * Script Quality Rules: the craft of a told story, checked deterministically
 * and for any subject — redundancy across sections, passenger facts, section
 * pacing, spoken-language naturalness, meta-narration, how people and
 * fictional devices are introduced, whether what is said about a person rests
 * on a claim about them, where to cut when a film runs long, and which
 * repetitions are deliberate (a refrain, a callback, an escalating series) and
 * must survive.
 *
 * These are heuristics over words and structure, not judgements of meaning:
 * they point the writer, the reviewers and the editor at likely problems. Only
 * one is blocking (a named real person with no claim about them); the rest are
 * warnings. Nothing here knows any particular documentary.
 */

// ── Words ────────────────────────────────────────────────────────────────────

/** English function words: they carry grammar, not content. */
const FUNCTION_WORDS = new Set(
  (
    'a about above after again against all almost also although always am among an and another any anyone anything are around as at away back be became because become been before being below between both but by can cannot could did do does doing done down during each either else enough even ever every few for from further get gets got had has have having he her here hers herself him himself his how however i if in into is it its itself just last least less let like made make many may me might more most much must my myself never next no nobody none nor not nothing now of off often on once one only onto or other others our ours ourselves out over own perhaps quite rather really same say says said see seen she should since so some something soon still such than that the their theirs them themselves then there these they thing things this those though through thus to together too toward towards under until up upon us very was we well were what whatever when where whether which while who whom whose why will with within without would yet you your yours yourself ' +
    "it's that's there's what's who's he's she's they're we're you're isn't wasn't weren't don't doesn't didn't can't couldn't won't wouldn't shouldn't i'm i've we've they've let's"
  ).split(/\s+/),
);

/** Content words of a text: lower-case, three letters or more, not function words or bare numbers. */
export function contentWords(text: string): string[] {
  return wordTokens(text).filter((w) => w.length >= 3 && !FUNCTION_WORDS.has(w) && !/^\d+$/.test(w));
}

/** Generic words for people, to measure how much narration has someone in it. */
const HUMAN_WORDS = new Set(
  'he she him her his hers they them their theirs we us our i me my man men woman women people person family families child children boy girl son sons daughter daughters father mother parents wife husband widow brother sister friend friends neighbour neighbours neighbor neighbors someone somebody everyone everybody nobody anyone crowd crowds stranger strangers citizens owner owners worker workers'.split(
    ' ',
  ),
);

/** Does the block have a person in it (a pronoun, a word for people, or a cast member)? */
export function humanIn(b: DraftBlock, scope: ScriptScope): boolean {
  const words = wordTokens(b.text);
  const cast = [...scope.cast.values()].flatMap((c) => c.tokens);
  return words.some((w) => HUMAN_WORDS.has(w) || cast.includes(w));
}

/** Narration the narrator speaks (not a cast member's line). */
const narrationOf = (draft: ScriptDraft) => allBlocks(draft).filter((b) => !b.speakerId);

/** Words that occur in a large share of the narration: the film's subject, not evidence of repetition. */
function topicWords(blocks: readonly DraftBlock[]): Set<string> {
  const df = new Map<string, number>();
  for (const b of blocks) for (const w of new Set(contentWords(b.text))) df.set(w, (df.get(w) ?? 0) + 1);
  const limit = Math.max(3, blocks.length * 0.3);
  return new Set([...df].filter(([, n]) => n >= limit).map(([w]) => w));
}

const clock = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const quoteSnippet = (s: string, n = 60) => `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"`;

// ── Proper names ─────────────────────────────────────────────────────────────

/** Capitalised words that are not names. */
const NOT_NAMES = new Set([
  ...'january february march april may june july august september october november december'.split(' '),
  ...'monday tuesday wednesday thursday friday saturday sunday'.split(' '),
  ...'i you your he she it we they his her its our their one someone everyone nobody each all both many most few some others'.split(' '),
  ...'the a an this that these those in on at of and or but from to with by for as so yet if when while then there here what who why how which'.split(' '),
  ...'god lord christmas easter'.split(' '),
]);

/** Lower-case words that belong inside a name ("Jan van Goyen", "Ibn al-Haytham"). */
const PARTICLES = new Set('van von de der den du da di del della la le ter ten bin ibn al'.split(' '));

/**
 * Verbs that make a capitalised word at the start of a sentence a person or
 * an authority ("Lindqvist argues"). Singular forms only: a plural subject
 * ("Critics argue") is not a name.
 */
const SAYS = new Set('says writes argues notes claims estimates reports suggests concludes recalls records observes insists describes explains believes thinks remembers admits warns calls puts'.split(' '));

/** Abstract subjects that say things without being anyone ("Evidence suggests"). */
const ABSTRACT_SUBJECTS = new Set('research evidence history legend tradition rumour rumor folklore science data analysis experience memory logic record story theory nature time everything nothing something'.split(' '));

/** A run of capitalised words in a sentence: a candidate name. */
interface NameRun {
  /** Its words, lower-case. */
  words: string[];
  /** As written ("Anne Goldgar"). */
  form: string;
  /** Its span in the sentence's tokens. */
  start: number;
  end: number;
}

/** A sentence as the name rules read it: lower-case tokens (words and the punctuation that separates clauses), the words written in lower case, and the capitalised runs. */
interface SentenceNames {
  tokens: string[];
  lower: string[];
  runs: NameRun[];
}

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’-]*|[,;:()—–]/gu;

function readNames(sentence: string): SentenceNames {
  const raw = [...sentence.matchAll(TOKEN)].map((m) => m[0].replace(/['’]s$/u, ''));
  const tokens = raw.map((t) => (/^[\p{L}\p{N}]/u.test(t) ? (wordTokens(t).sort((a, b) => b.length - a.length)[0] ?? t.toLowerCase()) : t));
  const lower = raw.flatMap((t, i) => (/^\p{Ll}/u.test(t) ? [tokens[i]!] : []));
  const runs: NameRun[] = [];
  let open: NameRun | null = null;
  raw.forEach((w, i) => {
    const t = tokens[i]!;
    const capital = /^\p{Lu}/u.test(w) && t.length >= 3 && !NOT_NAMES.has(t) && !/^\p{Lu}\d+$/u.test(w);
    if (capital) {
      if (open && open.end >= i - 2) {
        open.words.push(t);
        open.form = `${open.form} ${raw.slice(open.end + 1, i + 1).join(' ')}`;
        open.end = i;
      } else {
        open = { words: [t], form: w, start: i, end: i };
        runs.push(open);
      }
    } else if (!(open && open.end === i - 1 && PARTICLES.has(t) && /^\p{Lu}/u.test(raw[i + 1] ?? ''))) {
      open = null;
    }
  });
  return { tokens, lower, runs };
}

/** A name as used in one block. */
export interface NameMention {
  words: string[];
  form: string;
  /** The sentence's tokens, and the name's span in them. */
  tokens: string[];
  start: number;
  end: number;
}

export interface NameUse {
  /** As first written. */
  form: string;
  /** Blocks it appears in, in script order. */
  refs: string[];
}

export interface ScriptNames {
  /** Each word of a name, and the blocks it appears in. */
  words: Map<string, NameUse>;
  /** The names in each block (by block key), in order. */
  mentions: Map<string, NameMention[]>;
}

/**
 * Every proper name the narration uses, and where. A capitalised run inside a
 * sentence is a name. At the start of a sentence — where every word has a
 * capital — it is one when it has two or more words, when one of its words is
 * capitalised inside a sentence somewhere else, or when it says something
 * ("Lindqvist argues") and is never written in lower case.
 */
export function namesInScript(draft: ScriptDraft): ScriptNames {
  const read = narrationOf(draft).map((b) => ({ key: b.key, sentences: sentences(b.text).map(readNames) }));
  const inside = new Set(read.flatMap((r) => r.sentences.flatMap((s) => s.runs.filter((x) => x.start > 0 || x.words.length > 1).flatMap((x) => x.words))));
  const lower = new Set(read.flatMap((r) => r.sentences.flatMap((s) => s.lower)));
  const words = new Map<string, NameUse>();
  const mentions = new Map<string, NameMention[]>();
  for (const r of read) {
    const here: NameMention[] = [];
    for (const s of r.sentences) {
      for (const x of s.runs) {
        const speaks = SAYS.has(s.tokens[x.end + 1] ?? '') && !lower.has(x.words[0]!) && !ABSTRACT_SUBJECTS.has(x.words[0]!);
        if (x.start === 0 && x.words.length === 1 && !inside.has(x.words[0]!) && !speaks) continue;
        here.push({ words: x.words, form: x.form, tokens: s.tokens, start: x.start, end: x.end });
        for (const w of x.words) {
          const use = words.get(w) ?? { form: x.form, refs: [] };
          if (!use.refs.includes(r.key)) use.refs.push(r.key);
          words.set(w, use);
        }
      }
    }
    if (here.length) mentions.set(r.key, here);
  }
  return { words, mentions };
}

/** Words that attribute what is said to someone ("Okafor notes", "as Halvorsen wrote"). */
const ATTRIBUTION_VERBS = new Set('writes wrote argues argued notes noted says said concludes concluded suggests suggested estimates estimated claims claimed reports reported records recorded recalls recalled observes observed insists insisted describes described believes believed thinks thought'.split(' '));
/** Tokens that end a clause: an attribution verb after one of them belongs to another subject. */
const CLAUSE_BREAK = new Set([',', ';', ':', '(', ')', '—', '–', 'and', 'but', 'then', 'who', 'which', 'that', 'while', 'when', 'because']);

/** Is the name cited as an authority: "according to (the historian) X", or "X (…) notes" within the same clause? */
function cited(m: NameMention): boolean {
  const before = m.tokens.slice(Math.max(0, m.start - 4), m.start);
  const at = before.lastIndexOf('according');
  if (at >= 0 && before[at + 1] === 'to' && !before.slice(at + 2).some((t) => CLAUSE_BREAK.has(t))) return true;
  for (let i = m.end + 1; i <= m.end + 4 && i < m.tokens.length; i++) {
    const t = m.tokens[i]!;
    if (ATTRIBUTION_VERBS.has(t)) return true;
    if (CLAUSE_BREAK.has(t)) return false;
  }
  return false;
}

const castWords = (scope: ScriptScope) => new Set([...scope.cast.values()].flatMap((c) => c.tokens));

// ── Deliberate repetition ────────────────────────────────────────────────────

export interface Refrain {
  /** The repeated words, normalized ("not one"). */
  phrase: string;
  /** Blocks it occurs in. */
  refs: string[];
  /** REFRAIN: a short line said again. CALLBACK: an echo at a structural point (an opening and an ending, section edges). ESCALATION: a run of short sentences built the same way. */
  kind: 'REFRAIN' | 'CALLBACK' | 'ESCALATION';
}

/** A sentence short enough to carry a refrain. */
const SHORT = 7;

/**
 * Repetition that is a device, not a fault: the same short line said again
 * (a refrain), a phrase that returns at a structural point — the opening and
 * the ending, the edges of sections — (a callback), and runs of short
 * sentences built the same way ("Not one. Not ten. Not a hundred.") — an
 * escalation. The redundancy and repetition checks leave these alone, and a
 * refinement must keep them.
 */
export function detectRefrains(draft: ScriptDraft, scope: ScriptScope): Refrain[] {
  const blocks = allBlocks(draft);
  const sectionIndex = new Map<string, number>();
  const edge = new Set<string>();
  draft.sections.forEach((s, i) => {
    for (const b of s.blocks) sectionIndex.set(b.key, i);
    if (s.blocks[0]) edge.add(s.blocks[0].key);
    if (s.blocks.at(-1)) edge.add(s.blocks.at(-1)!.key);
  });
  const lastSection = draft.sections.length - 1;
  const names = castWords(scope);
  const meaningful = (tokens: readonly string[]) => tokens.some((t) => t.length >= 4 && !FUNCTION_WORDS.has(t) && !names.has(t) && !/^\d+$/.test(t));
  const out: Refrain[] = [];

  // Short lines said again.
  const lines = new Map<string, string[]>();
  for (const b of blocks) {
    for (const s of sentences(b.text)) {
      const t = wordTokens(s);
      if (t.length === 0 || t.length > SHORT || !meaningful(t)) continue;
      const k = t.join(' ');
      const refs = lines.get(k) ?? [];
      if (!refs.includes(b.key)) refs.push(b.key);
      lines.set(k, refs);
    }
  }
  for (const [phrase, refs] of lines) if (refs.length >= 2) out.push({ phrase, refs, kind: 'REFRAIN' });

  // Callbacks: a distinctive phrase — three to six words, two content words or
  // more, not only the film's subject words — that returns at a structural
  // point (the opening and the ending, the edges of sections) or echoes a
  // short line, in blocks that do not otherwise retell each other: an ending
  // that repeats the opening's facts is a recap, not a callback.
  const topic = topicWords(narrationOf(draft));
  const grams = new Map<string, { refs: string[]; inShort: boolean }>();
  for (const b of blocks) {
    for (const s of sentences(b.text)) {
      const t = wordTokens(s);
      for (let n = 3; n <= 6; n++) {
        for (let i = 0; i + n <= t.length; i++) {
          const g = t.slice(i, i + n);
          const content = g.filter((w) => w.length >= 3 && !FUNCTION_WORDS.has(w) && !/^\d+$/.test(w));
          if (content.length < 2 || content.every((w) => topic.has(w) || names.has(w)) || !meaningful(g)) continue;
          const k = g.join(' ');
          const e = grams.get(k) ?? { refs: [], inShort: false };
          if (!e.refs.includes(b.key)) e.refs.push(b.key);
          if (t.length <= SHORT) e.inShort = true;
          grams.set(k, e);
        }
      }
    }
  }
  const structural: Refrain[] = [];
  for (const [phrase, e] of grams) {
    if (e.refs.length < 2 || out.some((r) => r.phrase.includes(phrase))) continue;
    const sections = e.refs.map((r) => sectionIndex.get(r) ?? -1);
    const bookend = sections.includes(0) && sections.includes(lastSection) && lastSection > 0;
    const atEdges = e.refs.filter((r) => edge.has(r)).length >= 2 && new Set(sections).size >= 2;
    if (e.inShort || bookend || atEdges) structural.push({ phrase, refs: e.refs, kind: 'CALLBACK' });
  }
  // One phrase per echo: overlapping phrases in the same blocks merge into the longest stretch they all share.
  const texts = new Map(blocks.map((b) => [b.key, ` ${wordTokens(b.text).join(' ')} `]));
  const groups = new Map<string, Refrain[]>();
  for (const c of structural) groups.set(c.refs.join(','), [...(groups.get(c.refs.join(',')) ?? []), c]);
  const echoes: Refrain[] = [];
  for (const group of groups.values()) {
    const refs = group[0]!.refs;
    const merged = new Set<string>();
    for (const t of sentences(blocks.find((b) => b.key === refs[0])!.text).map((x) => wordTokens(x))) {
      const covered = t.map(() => false);
      for (const c of group) {
        const g = c.phrase.split(' ');
        for (let i = 0; i + g.length <= t.length; i++) if (g.every((w, j) => t[i + j] === w)) for (let j = 0; j < g.length; j++) covered[i + j] = true;
      }
      for (let i = 0; i < t.length; i++) {
        if (!covered[i]) continue;
        let j = i;
        while (j + 1 < t.length && covered[j + 1]) j++;
        merged.add(t.slice(i, j + 1).join(' '));
        i = j;
      }
    }
    const phrases = [...merged].filter((m) => refs.every((r) => texts.get(r)!.includes(` ${m} `)));
    for (const phrase of phrases.length ? phrases : group.map((c) => c.phrase)) echoes.push({ phrase, refs, kind: 'CALLBACK' });
  }
  // Blocks that share the echo and little else: a callback. Blocks that share much more, a whole sentence, or the
  // wording of a claim they both cite: a retelling.
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const contentOf = new Map(blocks.map((b) => [b.key, [...new Set(contentWords(b.text).filter((w) => !topic.has(w) && !names.has(w)))]]));
  const retold = (refs: readonly string[], phrase: string) => {
    const drop = new Set(phrase.split(' '));
    if (drop.size > 8) return true;
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        const x = contentOf.get(refs[i]!)!.filter((w) => !drop.has(w));
        const y = new Set(contentOf.get(refs[j]!)!.filter((w) => !drop.has(w)));
        const small = Math.min(x.length, y.size);
        if (small >= 3 && x.filter((w) => y.has(w)).length / small >= 0.45) return true;
        const shared = byKey.get(refs[i]!)!.claimKeys.filter((k) => byKey.get(refs[j]!)!.claimKeys.includes(k));
        const factWords = new Set(shared.flatMap((k) => contentWords(scope.evidence.claim(k)?.statement ?? '')));
        if (contentWords(phrase).filter((w) => factWords.has(w)).length >= 2) return true;
      }
    }
    return false;
  };
  echoes.sort((x, y) => y.phrase.split(' ').length - x.phrase.split(' ').length);
  for (const c of echoes) {
    if (retold(c.refs, c.phrase)) continue;
    if (!out.some((r) => r.phrase.includes(c.phrase) && c.refs.every((x) => r.refs.includes(x)))) out.push(c);
  }

  // Escalation: short sentences in a row that open the same way.
  for (const b of blocks) {
    const ss = sentences(b.text).map((s) => wordTokens(s));
    for (let i = 0; i + 1 < ss.length; i++) {
      const [x, y] = [ss[i]!, ss[i + 1]!];
      if (x.length && y.length && x.length <= SHORT && y.length <= SHORT && x[0] === y[0]) {
        if (!out.some((r) => r.kind === 'ESCALATION' && r.refs.includes(b.key))) out.push({ phrase: x[0]!, refs: [b.key], kind: 'ESCALATION' });
      }
    }
  }
  return out;
}

/** The text with refrain phrases taken out (so an echo does not count as a retelling). */
function withoutRefrains(text: string, refrains: readonly Refrain[]): string {
  let t = ` ${wordTokens(text).join(' ')} `;
  for (const r of refrains) if (r.kind !== 'ESCALATION') t = t.split(` ${r.phrase} `).join(' ');
  return t;
}

/** Does any sentence of the text belong to an escalation run (for the openings check)? */
export function inEscalation(b: DraftBlock, refrains: readonly Refrain[]): boolean {
  return refrains.some((r) => r.kind === 'ESCALATION' && r.refs.includes(b.key));
}

/** Is this repeated phrase part of a deliberate repetition? */
export function partOfRefrain(phrase: string, refrains: readonly Refrain[]): boolean {
  return refrains.some((r) => r.phrase.includes(phrase) || phrase.includes(r.phrase));
}

// ── 1. Redundancy ────────────────────────────────────────────────────────────

export interface Retelling {
  ref: string;
  /** The earlier block it retells. */
  of: string;
  /** Share of its content words (subject words aside) already said in `of`. */
  overlap: number;
  sharedEvidence: string[];
  crossSection: boolean;
}

/**
 * Blocks that say again what an earlier block said: most of their content
 * words (the film's subject words aside) already spoken, especially over the
 * same claims or beats. Deliberate echoes are taken out first.
 */
export function retellings(draft: ScriptDraft, refrains: readonly Refrain[]): Retelling[] {
  const blocks = narrationOf(draft);
  const topic = topicWords(blocks);
  const sectionOf = new Map<string, number>();
  for (const s of draft.sections) for (const b of s.blocks) sectionOf.set(b.key, s.sequence);
  const words = blocks.map((b) => new Set(contentWords(withoutRefrains(b.text, refrains)).filter((w) => !topic.has(w))));
  const out: Retelling[] = [];
  blocks.forEach((b, i) => {
    const mine = words[i]!;
    if (mine.size < 5 || b.centralQuestion === 'POSED') return;
    let best: Retelling | null = null;
    for (let j = 0; j < i; j++) {
      const shared = [...mine].filter((w) => words[j]!.has(w)).length;
      if (shared < 4) continue;
      const overlap = shared / mine.size;
      const a = blocks[j]!;
      const sharedEvidence = [...b.claimKeys.filter((k) => a.claimKeys.includes(k)), ...b.beatIds.filter((x) => a.beatIds.includes(x))];
      const retold = overlap >= 0.6 || (overlap >= 0.45 && sharedEvidence.length > 0);
      if (retold && (!best || overlap > best.overlap)) best = { ref: b.key, of: a.key, overlap, sharedEvidence, crossSection: sectionOf.get(a.key) !== sectionOf.get(b.key) };
    }
    if (best) out.push(best);
  });
  return out;
}

function redundancy(draft: ScriptDraft, refrains: readonly Refrain[], out: ScriptFinding[]): Retelling[] {
  const told = retellings(draft, refrains);
  const byRef = new Map(allBlocks(draft).map((b) => [b.key, b]));
  for (const r of told) {
    out.push({
      kind: 'RETOLD_CONTENT',
      ref: r.ref,
      detail: `Block ${r.ref} retells ${r.of} (${Math.round(r.overlap * 100)}% of its words${r.sharedEvidence.length ? `, the same ${r.sharedEvidence.join(', ')}` : ''}): the viewer has heard it — cut it, or say only what is new`,
    });
  }
  // A section that spends a large share of its time on what earlier sections said.
  for (const s of draft.sections) {
    const recap = told.filter((r) => r.crossSection && s.blocks.some((b) => b.key === r.ref));
    const sec = recap.reduce((n, r) => n + (byRef.get(r.ref)?.estimatedDurationSec ?? 0), 0);
    const total = s.blocks.reduce((n, b) => n + b.estimatedDurationSec, 0);
    if (recap.length >= 2 && total > 0 && sec / total >= 0.25) {
      out.push({ kind: 'RECAP_SECTION', ref: `S${s.sequence}`, detail: `Section ${s.sequence} spends ${clock(sec)} of ${clock(total)} retelling earlier sections (${recap.map((r) => r.ref).join(', ')}): move the story on, or land it, rather than summarise it` });
    }
  }
  // The same claim explained again and again across the film.
  const blocks = narrationOf(draft).filter((b) => b.infoClass !== 'FRAMING');
  const sectionOf = new Map<string, number>();
  for (const s of draft.sections) for (const b of s.blocks) sectionOf.set(b.key, s.sequence);
  const topic = topicWords(blocks);
  const keys = [...new Set(blocks.flatMap((b) => b.claimKeys))];
  for (const k of keys) {
    const citing = blocks.filter((b) => b.claimKeys.includes(k));
    const sections = [...new Set(citing.map((b) => sectionOf.get(b.key)!))];
    if (sections.length < 3) continue;
    const sets = citing.map((b) => new Set(contentWords(withoutRefrains(b.text, refrains)).filter((w) => !topic.has(w))));
    let pairs = 0;
    let sum = 0;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const [x, y] = [sets[i]!, sets[j]!];
        const small = Math.min(x.size, y.size);
        if (small === 0) continue;
        sum += [...x].filter((w) => y.has(w)).length / small;
        pairs++;
      }
    }
    if (pairs && sum / pairs >= 0.3) out.push({ kind: 'CLAIM_RETOLD', ref: citing[0]!.key, detail: `${k} is explained in sections ${sections.join(', ')} (${citing.map((b) => b.key).join(', ')}): explain it once, then refer to it` });
  }
  return told;
}

// ── 2. Low-value exposition ──────────────────────────────────────────────────

/**
 * Facts along for the ride: a fact block that rests only on background
 * claims, names someone or something the film never mentions again, has
 * nobody in it, or only cites an authority — two of these and it is probably
 * a passenger. Also: authorities named once and only to be cited, and blocks
 * that load several new names at once.
 */
function exposition(draft: ScriptDraft, scope: ScriptScope, out: ScriptFinding[]): void {
  const names = namesInScript(draft);
  const cast = castWords(scope);
  const once = (m: NameMention) => m.words.every((w) => (names.words.get(w)?.refs.length ?? 0) <= 1 && !cast.has(w));
  const firstHere = (m: NameMention, key: string) => m.words.every((w) => names.words.get(w)?.refs[0] === key) && !m.words.some((w) => cast.has(w));
  const unique = (xs: readonly string[]) => [...new Set(xs)];
  const chatter: { ref: string; form: string }[] = [];

  for (const b of narrationOf(draft)) {
    const mentions = names.mentions.get(b.key) ?? [];
    const orphans = unique(mentions.filter(once).map((m) => m.form));
    const authorities = unique(mentions.filter((m) => once(m) && cited(m)).map((m) => m.form));
    chatter.push(...authorities.map((form) => ({ ref: b.key, form })));
    const fresh = unique(mentions.filter((m) => firstHere(m, b.key)).map((m) => m.form));
    if (fresh.length >= 3) out.push({ kind: 'NAME_LOAD', ref: b.key, detail: `Block ${b.key} introduces ${fresh.length} new names at once (${fresh.join(', ')}): the ear holds one at a time` });

    if ((b.infoClass !== 'DOCUMENTED' && b.infoClass !== 'UNCERTAIN') || b.centralQuestion) continue;
    const importance = b.claimKeys.map((k) => scope.evidence.claim(k)?.importance);
    // A block that carries a key claim is never a passenger.
    if (importance.includes('KEY')) continue;
    const reasons: string[] = [];
    const background = importance.length > 0 && importance.every((i) => i === 'BACKGROUND');
    if (background) reasons.push('rests only on background claims');
    if (orphans.length) reasons.push(`names ${orphans.join(', ')} and never again`);
    if (authorities.length) reasons.push(`cites ${authorities.join(', ')} for its own sake`);
    if (!humanIn(b, scope)) reasons.push('has nobody in it');
    const functions = b.beatIds.map((id) => scope.beats.get(id)?.beat.function);
    if (functions.length && functions.every((f) => f === 'ORIENTATION' || f === 'TRANSITION')) reasons.push('only orients');
    if (reasons.length >= 2 && (background || orphans.length > 0 || authorities.length > 0)) {
      out.push({ kind: 'PASSENGER_FACT', ref: b.key, detail: `Block ${b.key} may be a passenger: ${reasons.join('; ')} — cut it, or tie it to the people and the question` });
    }
  }
  const authorities = unique(chatter.map((c) => c.form));
  if (authorities.length >= 3) {
    out.push({ kind: 'SOURCE_CHATTER', ref: chatter[0]!.ref, detail: `The narration cites ${authorities.length} authorities it names only once (${authorities.join(', ')}): name a source when it becomes part of the story, not to footnote it` });
  }
}

// ── 3. Section pacing ────────────────────────────────────────────────────────

const plannedSec = (s: DraftSection) => s.plan?.targetSec || s.targetDurationSec || 0;
const durationOf = (s: DraftSection) => s.blocks.reduce((n, b) => n + b.estimatedDurationSec, 0);

/** A section's share of the film, by plan (equal shares without one). */
function shares(draft: ScriptDraft): Map<number, number> {
  const planned = draft.sections.map(plannedSec);
  const total = planned.reduce((a, b) => a + b, 0);
  return new Map(draft.sections.map((s, i) => [s.sequence, total > 0 ? planned[i]! / total : 1 / Math.max(draft.sections.length, 1)]));
}

/**
 * Where the time goes: when the film runs over its maximum, the sections
 * furthest over their planned share of it (where to cut first); and an ending
 * that drags — much longer than a typical section and than its plan.
 */
function pacing(draft: ScriptDraft, timing: ScriptTiming, out: ScriptFinding[]): void {
  if (timing.totalSec > timing.maxSec) {
    const share = shares(draft);
    for (const s of draft.sections) {
      const budget = (share.get(s.sequence) ?? 0) * timing.maxSec;
      const actual = durationOf(s);
      if (actual - budget >= 15 && actual > budget * 1.2) {
        out.push({ kind: 'SECTION_OVER_BUDGET', ref: `S${s.sequence}`, detail: `Section ${s.sequence} runs ${clock(actual)}; its planned share of a ${clock(timing.maxSec)} film is ${clock(budget)} — ${clock(actual - budget)} over: cut here first` });
      }
    }
  }
  if (draft.sections.length >= 3) {
    const last = draft.sections.at(-1)!;
    const others = draft.sections.slice(0, -1).map(durationOf).sort((a, b) => a - b);
    const median = others[Math.floor(others.length / 2)]!;
    const planned = plannedSec(last);
    const actual = durationOf(last);
    if (median > 0 && actual >= median * 1.5 && planned > 0 && actual > planned * 1.3) {
      out.push({ kind: 'ENDING_DRAG', ref: `S${last.sequence}`, detail: `The ending runs ${clock(actual)}, ${(actual / median).toFixed(1)} times a typical section and ${clock(actual - planned)} over its plan: an ending lands; it does not recap` });
    }
  }
}

// ── 4. Spoken-language naturalness ───────────────────────────────────────────

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DAY_OF_MONTH = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?=${MONTHS})|(?<=(?:${MONTHS})\\s+)\\d{1,2}(?:st|nd|rd|th)?\\b`, 'g');
const WRITTEN_WORDS = /\b(respectively|the former|the latter|namely|whereby|thereof|therein|wherein|aforementioned|notwithstanding|hitherto|henceforth|insofar|inasmuch|thereby)\b/i;
const NOMINAL = /(?:tion|sion|ment|ance|ence|ity|ness|ism)$/;

/**
 * Page syntax a listener has to untangle: colons, semicolons, parentheses and
 * written-register words; lists in one breath; strings of numbers; noun-heavy
 * sentences; and sections whose sentences all run the same length.
 */
function naturalness(draft: ScriptDraft, out: ScriptFinding[]): void {
  for (const b of narrationOf(draft)) {
    const text = b.text.replace(/["“][^"”]*["”]/g, '"…"');
    const page: string[] = [];
    if (/;/.test(text)) page.push('a semicolon');
    if (/[(\[]/.test(text)) page.push('parentheses');
    if (/:(?!\d)/.test(text.replace(/\d:\d/g, ''))) page.push('a colon');
    const word = WRITTEN_WORDS.exec(text);
    if (word) page.push(`"${word[0]}"`);
    if (page.length) out.push({ kind: 'WRITTEN_SYNTAX', ref: b.key, detail: `Block ${b.key} uses ${page.join(', ')}: page syntax — say it as separate sentences` });
    for (const s of sentences(text)) {
      const parts = s.split(/[,;:]/).map((p) => wordTokens(p).length).filter((n) => n > 0);
      // Four or more items (a deliberate triple is rhetoric, not a list).
      const listy = parts.length >= 5 && parts.slice(1, -1).every((n) => n <= 4) && /\b(and|or)\b/i.test(s.split(/[,;:]/).at(-1) ?? '');
      if (listy) {
        out.push({ kind: 'LIST_SENTENCE', ref: b.key, detail: `Block ${b.key} lists ${parts.length - 1} or more items in one sentence (${quoteSnippet(s)}): keep one or two, or give each its moment` });
        break;
      }
    }
    for (const s of sentences(text)) {
      // The day of a date ("3 February", "February 3rd") is part of the date, not another number.
      const numbers = (s.replace(DAY_OF_MONTH, '').match(/\d[\d,.]*/g) ?? []).length;
      if (numbers >= 3) {
        out.push({ kind: 'NUMBER_DENSE', ref: b.key, detail: `Block ${b.key} says ${numbers} numbers in one sentence (${quoteSnippet(s)}): one number per breath` });
        break;
      }
    }
    for (const s of sentences(text)) {
      const w = wordTokens(s);
      const nominal = w.filter((x) => x.length >= 8 && NOMINAL.test(x));
      if (w.length >= 14 && nominal.length >= 3) {
        out.push({ kind: 'NOUN_HEAVY', ref: b.key, detail: `Block ${b.key} reads like an essay (${nominal.slice(0, 4).join(', ')}): use people and verbs` });
        break;
      }
    }
  }
  for (const s of draft.sections) {
    const lengths = s.blocks.filter((b) => !b.speakerId).flatMap((b) => sentences(b.text).map((x) => wordTokens(x).length)).filter((n) => n > 0);
    if (lengths.length < 8) continue;
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
    if (mean > 0 && sd / mean < 0.3) out.push({ kind: 'MONOTONOUS_RHYTHM', ref: `S${s.sequence}`, detail: `Section ${s.sequence}: ${lengths.length} sentences of nearly the same length (about ${Math.round(mean)} words): vary them — short for turns, longer for context` });
  }
}

// ── 5. Meta-narration ────────────────────────────────────────────────────────

const META: RegExp[] = [
  /\b(?:this|our) (?:film|documentary|episode|video|programme|program|series)\b/i,
  /\bwe(?:'re| are) (?:going to|about to) (?:test|look|explore|ask|see|find|examine|investigate|follow|meet|answer|tell)\b/i,
  /\bwe(?:'ll| will| shall) (?:test|look|explore|ask|see|find out|examine|investigate|return|come back|meet|answer|get to)\b/i,
  /\blet(?:'s| us) (?:look|see|start|begin|go back|take a|turn|test|ask|find out|meet|rewind|return)\b/i,
  /\balong the way\b/i,
  /\bas we(?:'ll| will)? (?:see|saw|discover|learn)\b/i,
  /\b(?:more on|back to) (?:that|this|him|her|them) (?:later|in a moment|shortly)\b/i,
  /\bbefore we (?:test|look|go|answer|get|start|begin|dive)\b/i,
  /\bso what(?:'s| is| was) the (?:source|answer|evidence|record|truth)\b/i,
  /\b(?:here's|here is) (?:the|our) (?:question|plan|problem|puzzle)\b/i,
  /\bin this (?:chapter|section|part|episode)\b/i,
  /\byou(?:'ll| will) (?:see|meet|learn|discover|hear)\b/i,
];

/**
 * The narrator talking about the film instead of telling the story. One line
 * that frames the investigation, in the first section, is allowed; every
 * other is flagged.
 */
function metaNarration(draft: ScriptDraft, out: ScriptFinding[]): void {
  let allowance = 1;
  draft.sections.forEach((s, i) => {
    for (const b of s.blocks) {
      if (b.speakerId) continue;
      const text = b.text.replace(/["“][^"”]*["”]/g, '');
      const hit = META.map((re) => re.exec(text)).find(Boolean);
      if (!hit) continue;
      if (i === 0 && allowance > 0) {
        allowance--;
        continue;
      }
      out.push({ kind: 'META_NARRATION', ref: b.key, detail: `Block ${b.key} talks about the film ("${hit[0]}"): let the viewer experience the investigation instead of being told about it` });
    }
  });
}

// ── 6. Introductions ─────────────────────────────────────────────────────────

const DISCLAIMER = /\b(invented|made[- ]up|fictional|fictitious|imaginary|imagined|composite|not (?:a )?real|isn'?t real|never (?:existed|lived)|didn'?t exist|did not exist|our own invention|stand-in)\b/gi;
const LABEL_CUE = /\b(label|labelled|labeled|caption|fiction|fictional|invented|composite|imagined)\b/i;
const ROLE_CUES = new Set(['a', 'an', 'the', 'named', 'called', 'one', 'his', 'her', 'their', 'whose']);

const disclaimers = (text: string) => [...new Set([...text.matchAll(DISCLAIMER)].map((m) => m[0].toLowerCase().replace(/[- ]/g, ' ')))];

/**
 * People and devices as the viewer meets them. A fictional device is
 * introduced once, plainly — in the narration or by an on-screen label — not
 * labelled again and again, and not several ways at once. A real person is
 * introduced by what they do the first time they are named.
 */
function introductions(draft: ScriptDraft, scope: ScriptScope, out: ScriptFinding[]): void {
  const blocks = allBlocks(draft);
  for (const device of fictionalCast(scope)) {
    if (device.member.kind === 'POV_PROXY' || device.tokens.length === 0) continue;
    const mentions = blocks.filter((b) => b.speakerId === device.member.id || wordTokens(b.text).some((w) => device.tokens.includes(w)));
    if (!mentions.length) continue;
    const labelled = mentions.filter((b) => !b.speakerId && disclaimers(b.text).length > 0);
    for (const b of labelled) {
      const ways = disclaimers(b.text);
      if (ways.length >= 2) out.push({ kind: 'DEVICE_LABEL_STACKED', ref: b.key, detail: `Block ${b.key} says ${device.member.name} is not real ${ways.length} ways (${ways.join(', ')}): once, plainly` });
    }
    if (labelled.length >= 2) {
      out.push({ kind: 'DEVICE_RELABELLED', ref: labelled[1]!.key, detail: `${device.member.name} is labelled as invented in ${labelled.length} blocks (${labelled.map((b) => b.key).join(', ')}): say it once, at the introduction` });
    }
    const opening = mentions.slice(0, 2);
    const visual = (b: DraftBlock) => LABEL_CUE.test([b.visual.note, ...b.visual.mustShow.map((m) => m.detail)].join(' '));
    if (!opening.some((b) => (!b.speakerId && disclaimers(b.text).length > 0) || visual(b))) {
      out.push({ kind: 'DEVICE_UNINTRODUCED', ref: mentions[0]!.key, detail: `${device.member.name} first appears in ${mentions[0]!.key} without being introduced as invented (in the narration or an on-screen label)` });
    }
  }
  for (const person of realCast(scope)) {
    if (person.member.kind !== 'REAL_PERSON' || person.tokens.length === 0) continue;
    const first = blocks.find((b) => !b.speakerId && wordTokens(b.text).some((w) => person.tokens.includes(w)));
    if (!first) continue;
    const sentence = sentences(first.text).find((s) => wordTokens(s).some((w) => person.tokens.includes(w))) ?? first.text;
    const words = wordTokens(sentence);
    const at = words.findIndex((w) => person.tokens.includes(w));
    const before = words.slice(Math.max(0, at - 4), at);
    const afterName = new RegExp(`\\b(?:${person.tokens.join('|')})(?:'s)?,\\s+(?:a|an|the|who|whose|then|once|now|later|one|another)\\b`, 'i');
    const describes = contentWords(person.member.description).filter((w) => w.length >= 4 && !person.tokens.includes(w));
    const introduced = before.some((w) => ROLE_CUES.has(w)) || afterName.test(sentence) || words.some((w) => describes.includes(w));
    if (!introduced) out.push({ kind: 'PERSON_UNINTRODUCED', ref: first.key, detail: `${person.member.name} is named in ${first.key} without saying who they are: introduce people by what they do the first time` });
  }
}

// ── 7. Factual assertion → evidence ──────────────────────────────────────────

/**
 * Whatever is said about a named real person must rest on a claim about
 * them: a documented or uncertain block that names a person none of its
 * claims mentions is blocking (cite the claim — with its verdict's wording —
 * or cut the name); in a reconstructed scene it is a warning. A sentence that
 * says most of what an uncited claim says is flagged for the fact checker.
 */
function evidenceCompleteness(draft: ScriptDraft, scope: ScriptScope, out: ScriptFinding[]): void {
  const blocks = narrationOf(draft).filter((b) => b.infoClass === 'DOCUMENTED' || b.infoClass === 'UNCERTAIN' || b.infoClass === 'RECONSTRUCTION');
  const topic = topicWords(narrationOf(draft));
  const people = realCast(scope).filter((c) => c.member.kind === 'REAL_PERSON' && c.tokens.length > 0);
  const claimWords = new Map(scope.claims.map((k) => [k, new Set(wordTokens(scope.evidence.textFor([k])))]));
  const statementWords = new Map(scope.claims.map((k) => [k, [...new Set(contentWords(scope.evidence.claim(k)?.statement ?? ''))]]));
  for (const b of blocks) {
    const words = new Set(wordTokens(b.text));
    const cited = new Set(b.claimKeys.flatMap((k) => [...(claimWords.get(k) ?? [])]));
    for (const p of people) {
      if (!p.tokens.some((t) => words.has(t))) continue;
      if (p.member.claimKeys.some((k) => b.claimKeys.includes(k)) || p.tokens.some((t) => cited.has(t))) continue;
      const about = scope.claims.filter((k) => p.member.claimKeys.includes(k) || p.tokens.some((t) => claimWords.get(k)?.has(t))).slice(0, 3);
      out.push({
        kind: b.infoClass === 'RECONSTRUCTION' ? 'PERSON_WITHOUT_EVIDENCE_SCENE' : 'PERSON_WITHOUT_EVIDENCE',
        ref: b.key,
        detail: `Block ${b.key} names ${p.member.name} but cites no claim about them${about.length ? ` (${about.join(', ')} ${about.length > 1 ? 'are' : 'is'})` : ''}: cite it, worded as its verdict requires, or cut the name`,
      });
    }
    // A sentence that says what an uncited claim says.
    const mine = new Set(contentWords(b.text));
    const citedContent = new Set(contentWords(scope.evidence.textFor(b.claimKeys)));
    let best: { key: string; hit: string[]; ratio: number } | null = null;
    for (const k of scope.claims) {
      if (b.claimKeys.includes(k)) continue;
      const distinctive = (statementWords.get(k) ?? []).filter((w) => !citedContent.has(w) && !topic.has(w));
      if (distinctive.length < 4) continue;
      const hit = distinctive.filter((w) => mine.has(w));
      const ratio = hit.length / distinctive.length;
      if (hit.length >= 4 && ratio >= 0.6 && (!best || ratio > best.ratio)) best = { key: k, hit, ratio };
    }
    if (best) {
      const verdict = scope.evidence.claim(best.key)?.verdict;
      out.push({ kind: 'UNCITED_CLAIM_MATCH', ref: b.key, detail: `Block ${b.key} may state ${best.key} (${verdict}) without citing it (it shares ${best.hit.slice(0, 5).join(', ')}): cite it and word it as its verdict requires, or cut it` });
    }
  }
}

// ── 8. Deliberate repetition kept (refinement) ───────────────────────────────

/**
 * Refrains and callbacks of the version refined that the refinement dropped,
 * or cut to a single telling — once, it no longer repeats.
 */
function refrainsLost(previous: ScriptDraft, draft: ScriptDraft, scope: ScriptScope, out: ScriptFinding[]): void {
  const now = allBlocks(draft).map((b) => ({ key: b.key, text: ` ${wordTokens(b.text).join(' ')} ` }));
  for (const r of detectRefrains(previous, scope)) {
    if (r.kind === 'ESCALATION') continue;
    // It survives while a three-word part of it, two content words or more, still returns: a refinement may reword around it.
    const words = r.phrase.split(' ');
    const thirds = words.length > 3 ? words.slice(0, -2).map((_, i) => words.slice(i, i + 3).join(' ')).filter((p) => contentWords(p).length >= 2) : [];
    const parts = thirds.length ? thirds : [r.phrase];
    const still = parts.map((p) => now.filter((b) => b.text.includes(` ${p} `)).map((b) => b.key)).sort((a, b) => b.length - a.length)[0] ?? [];
    if (still.length >= 2) continue;
    const what = `The ${r.kind === 'REFRAIN' ? 'refrain' : 'callback'} "${r.phrase}" (${r.refs.join(', ')} in the previous version)`;
    out.push({ kind: 'REFRAIN_LOST', ref: still[0] ?? null, detail: `${what} ${still.length ? `is said only once now (${still[0]})` : 'is gone'}: repetition that pays off is not redundancy` });
  }
}

// ── 9. Runtime: where to cut ─────────────────────────────────────────────────

export interface TrimCandidate {
  ref: string;
  sec: number;
  reasons: string[];
}

export interface TrimPlan {
  totalSec: number;
  maxSec: number;
  targetSec: number;
  overMaxSec: number;
  /** Ranked: cut or compress these first, until the film fits. */
  candidates: TrimCandidate[];
  /** Never cut: the central question, recorded quotations, introductions, the turn and the reveals, refrains, lines kept on purpose, the only telling of a key claim. */
  protected: { ref: string; why: string }[];
}

/** Blocks that must survive any cut, and why. */
export function protectedBlocks(draft: ScriptDraft, scope: ScriptScope, refrains: readonly Refrain[], kept: readonly string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const put = (ref: string, why: string) => out.has(ref) || out.set(ref, why);
  const blocks = allBlocks(draft);
  const keptWords = kept.map((l) => wordTokens(l).join(' ')).filter((l) => l.split(' ').length >= 3);
  for (const b of blocks) {
    if (b.centralQuestion) put(b.key, b.centralQuestion === 'POSED' ? 'poses the central question' : 'answers the central question');
    if (b.speechKind === 'RECORDED_QUOTE') put(b.key, 'a recorded quotation');
    const words = ` ${wordTokens(b.text).join(' ')} `;
    if (keptWords.some((l) => words.includes(` ${l} `))) put(b.key, 'kept on purpose');
    const functions = b.beatIds.map((id) => scope.beats.get(id)?.beat.function);
    if (functions.includes('TURN')) put(b.key, 'the turn');
    if (functions.includes('REVEAL')) put(b.key, 'a reveal');
  }
  for (const r of refrains) for (const ref of r.refs) put(ref, r.kind === 'ESCALATION' ? 'an escalation' : `a ${r.kind.toLowerCase()} ("${r.phrase}")`);
  for (const c of scope.cast.values()) {
    if (c.member.kind === 'POV_PROXY') continue;
    const first = blocks.find((b) => b.speakerId === c.member.id || wordTokens(b.text).some((w) => c.tokens.includes(w)));
    if (first) put(first.key, `introduces ${c.member.name}`);
  }
  const key = blocks.flatMap((b) => b.claimKeys.filter((k) => scope.evidence.claim(k)?.importance === 'KEY').map((k) => [k, b.key] as const));
  for (const k of new Set(key.map(([c]) => c))) {
    const tellers = [...new Set(key.filter(([c]) => c === k).map(([, r]) => r))];
    if (tellers.length === 1) put(tellers[0]!, `the only telling of ${k}`);
  }
  return out;
}

const CUT_WEIGHT: Partial<Record<ScriptFinding['kind'], { score: number; why: string }>> = {
  RETOLD_CONTENT: { score: 3, why: 'retells an earlier block' },
  PASSENGER_FACT: { score: 3, why: 'a passenger fact' },
  META_NARRATION: { score: 2, why: 'talks about the film' },
  NAME_LOAD: { score: 1, why: 'several new names' },
  UNCITED_CLAIM_MATCH: { score: 1, why: 'an uncited assertion' },
  WRITTEN_SYNTAX: { score: 0.5, why: 'compress: page syntax' },
  LIST_SENTENCE: { score: 0.5, why: 'compress: a list' },
  NOUN_HEAVY: { score: 0.5, why: 'compress: essay prose' },
  NUMBER_DENSE: { score: 0.5, why: 'compress: numbers' },
};

/**
 * When a film runs over its maximum: the blocks to cut or compress first,
 * ranked by the craft findings against them (retellings and passengers first)
 * and by how far over its share their section runs — never a protected block.
 * Enough candidates to cover the excess with room to choose.
 */
export function trimPlan(draft: ScriptDraft, timing: ScriptTiming, findings: readonly ScriptFinding[], protect: ReadonlyMap<string, string>, scope: ScriptScope): TrimPlan | null {
  if (timing.totalSec <= timing.maxSec) return null;
  const overSections = new Set(findings.filter((f) => f.kind === 'SECTION_OVER_BUDGET' || f.kind === 'ENDING_DRAG').map((f) => f.ref));
  const candidates: (TrimCandidate & { score: number })[] = [];
  for (const s of draft.sections) {
    for (const b of s.blocks) {
      if (protect.has(b.key)) continue;
      let score = 0;
      const reasons: string[] = [];
      for (const f of findings) {
        const w = f.ref === b.key ? CUT_WEIGHT[f.kind] : undefined;
        if (w) {
          score += w.score;
          if (!reasons.includes(w.why)) reasons.push(w.why);
        }
      }
      if (overSections.has(`S${s.sequence}`)) {
        score += 1;
        reasons.push(`section ${s.sequence} runs long`);
      }
      const importance = b.claimKeys.map((k) => scope.evidence.claim(k)?.importance);
      if (importance.length && importance.every((i) => i === 'BACKGROUND')) {
        score += 1;
        reasons.push('background only');
      }
      if (score > 0) candidates.push({ ref: b.key, sec: Math.round(b.estimatedDurationSec * 10) / 10, reasons, score });
    }
  }
  const ranked = candidates.sort((a, b) => b.score - a.score || b.sec - a.sec);
  const over = timing.totalSec - timing.maxSec;
  const chosen: TrimCandidate[] = [];
  let covered = 0;
  for (const c of ranked) {
    if (covered >= over * 1.5 && chosen.length >= 3) break;
    chosen.push({ ref: c.ref, sec: c.sec, reasons: c.reasons });
    covered += c.sec;
  }
  return {
    totalSec: timing.totalSec,
    maxSec: timing.maxSec,
    targetSec: timing.targetSec,
    overMaxSec: Math.round(over * 10) / 10,
    candidates: chosen,
    protected: [...protect].map(([ref, why]) => ({ ref, why })),
  };
}

/** The plan as the reviewers read it. */
export function renderTrimPlan(plan: TrimPlan): string {
  return [
    `This version runs ${clock(plan.totalSec)}, ${clock(plan.overMaxSec)} over the acceptable maximum of ${clock(plan.maxSec)} (the midpoint is ${clock(plan.targetSec)}).`,
    plan.candidates.length ? 'Cut or compress first (ranked by the rules):' : 'The rules found no obvious cut: tighten sentences in the longest sections.',
    ...plan.candidates.map((c) => `- ${c.ref} (${c.sec.toFixed(1)} s): ${c.reasons.join('; ')}`),
    plan.protected.length ? `Never cut: ${plan.protected.map((p) => `${p.ref} (${p.why})`).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ── The writer's own account of length ───────────────────────────────────────

/**
 * A writer's change log that misstates the length (models estimate their own
 * output poorly): the words or the runtime it claims for the whole film,
 * against the measured ones, when they differ by more than a tenth. Figures
 * far from the whole film's (a section's words, a cut of some seconds) are
 * not claims about it. Null when it claims neither or is close.
 */
export function selfReportMismatch(text: string, timing: ScriptTiming): string | null {
  const whole = (n: number, measured: number) => measured > 0 && n >= measured * 0.4 && n <= measured * 2.5;
  const off = (n: number, measured: number) => Math.abs(n - measured) / measured > 0.1;
  const said: string[] = [];
  const words = [...text.matchAll(/(\d[\d,]*)\s+(?:spoken\s+)?words/gi)].map((m) => Number(m[1]!.replace(/,/g, ''))).find((n) => whole(n, timing.words));
  if (words !== undefined && off(words, timing.words)) said.push(`${words.toLocaleString('en')} words`);
  const sec = [...[...text.matchAll(/\b(\d{1,2}):([0-5]\d)\b/g)].map((m) => Number(m[1]) * 60 + Number(m[2])), ...[...text.matchAll(/(\d+(?:\.\d+)?)\s+minutes/gi)].map((m) => Number(m[1]) * 60)].find((n) => whole(n, timing.totalSec));
  if (sec !== undefined && off(sec, timing.totalSec)) said.push(clock(sec));
  return said.length ? `The writer's change log claims ${said.join(' and ')}; measured: ${timing.words.toLocaleString('en')} words, ${clock(timing.totalSec)}` : null;
}

// ── All of it ────────────────────────────────────────────────────────────────

export interface CraftOptions {
  /** The version this one refines: its refrains must survive. */
  previous?: ScriptDraft | null;
}

/** The craft findings of a version (warnings, and the one blocking evidence rule), plus what they rest on. */
export function craftFindings(draft: ScriptDraft, scope: ScriptScope, timing: ScriptTiming, opts: CraftOptions = {}): { findings: ScriptFinding[]; refrains: Refrain[] } {
  const out: ScriptFinding[] = [];
  const refrains = detectRefrains(draft, scope);
  redundancy(draft, refrains, out);
  exposition(draft, scope, out);
  pacing(draft, timing, out);
  naturalness(draft, out);
  metaNarration(draft, out);
  introductions(draft, scope, out);
  evidenceCompleteness(draft, scope, out);
  if (opts.previous) refrainsLost(opts.previous, draft, scope, out);
  return { findings: out, refrains };
}
