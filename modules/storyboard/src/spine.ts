import { SCOPE_END, SCOPE_START, type CutPointKind, type NarrationSpine } from '@docengine/core';
import type { DraftBlock, DraftSection, ScriptDraft } from '@docengine/script';
import { sentenceSpans, wordSpans } from '@docengine/voice';

/**
 * The narration spine: every word of the pinned assembly on its real clock,
 * with its script block, its index in the block's words and its sentence,
 * the silences between words, and the catalogue of cut points — the only
 * places a cut may fall. Words are read from the take each entry names (by
 * entry.generationId) and mapped to blocks by character offset, exactly as
 * the alignment tokenized them. Nothing is estimated: a word the provider
 * did not time keeps its place but never bounds a cut (its display time is
 * interpolated), and a take without word timings offers only its clip
 * edges, which are real audio.
 */

export class SpineIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpineIntegrityError';
  }
}

/** Inter-word silences longer than this are listed. */
export const SILENCE_MIN_MS = 120;
/** A pause inside a sentence (not at a clause) is a cut point only from this length. */
export const PAUSE_CUT_MS = 400;
/** A clause boundary needs at least this many words after it in the sentence. */
const CLAUSE_MIN_WORDS = 3;
const CLAUSE_MARK = /[,;:—–]|\s-\s/;

export interface SpineWord {
  /** Position in the scope's words. */
  index: number;
  blockKey: string;
  blockId: string;
  /** Index in the block's words. */
  word: number;
  text: string;
  /** Character range in the block's text. */
  start: number;
  end: number;
  /** Sentence of the block it belongs to. */
  sentence: number;
  /** Heard from/to on the assembled clock; interpolated for display only when untimed. */
  startMs: number;
  endMs: number;
  timed: boolean;
  /**
   * When it is surely heard, never an estimate: its own times when timed;
   * otherwise from the timed word before it in its clip (or the clip's
   * start) to the timed word after it (or the clip's end).
   */
  heard: { startMs: number; endMs: number };
  /** The assembly entry (clip) it is heard in. */
  entry: number;
  takeId: string;
  chunkId: string;
}

export interface SpineBlock {
  id: string;
  key: string;
  sectionKey: string;
  sequence: number;
  /** The section's row (scenes.id). */
  sceneId: string;
  block: DraftBlock;
  /** Positions of its first and last word in the scope's words. */
  first: number;
  last: number;
  startMs: number;
  endMs: number;
}

export interface CutPoint {
  /** Canonical id ("1.3:12", "1.3:end", "⟨start⟩", "⟨end⟩"). */
  id: string;
  /** Other ids naming the same boundary ("1.4:0" for "1.3:end"). */
  aliases: string[];
  /** The boundary before this position of the scope's words (0: the start; words.length: the end). */
  position: number;
  kind: CutPointKind;
  /** The block whose words the point is in or ends (null at the scope's edges). */
  blockKey: string | null;
  silence: { startMs: number; endMs: number };
  /** The default cut time: the middle of its silence (the scope's edges: 0 and the end). */
  atMs: number;
  /** Inside a sentence: a cut here needs a reason. */
  midSentence: boolean;
  /** A side is the clip edge of a take (real audio). */
  clipEdge: boolean;
}

export interface SpineSection {
  key: string;
  sequence: number;
  sceneId: string;
  title: string;
}

export interface Spine {
  narration: NarrationSpine;
  totalDurationMs: number;
  blocks: SpineBlock[];
  sections: SpineSection[];
  words: SpineWord[];
  silences: { startMs: number; endMs: number }[];
  points: CutPoint[];
  /** Takes without word timings (only their clip edges are cuts). */
  unalignedTakes: string[];
  /** Blocks of the script the narration does not cover (out of scope; counted, never estimated). */
  outOfScope: DraftBlock[];
  /** The cut point any of its ids names. */
  point(id: string): CutPoint | undefined;
  /** The cut point at a boundary, if the boundary is one. */
  at(position: number): CutPoint | undefined;
  block(key: string): SpineBlock | undefined;
}

interface Located {
  section: DraftSection;
  block: DraftBlock;
}

/** The spine of a pinned assembly over the approved script; throws SpineIntegrityError when they do not belong together. */
export function buildSpine(narration: NarrationSpine, script: ScriptDraft): Spine {
  const issues: string[] = [];
  const fail = (msg: string) => issues.push(msg);
  const byKey = new Map<string, Located>();
  for (const section of script.sections) {
    if (!section.rowId) throw new SpineIntegrityError(`Section ${section.key} of the script has no row id: load the script from its rows`);
    for (const block of section.blocks) {
      if (!block.rowId) throw new SpineIntegrityError(`Block ${block.key} of the script has no row id: load the script from its rows`);
      byKey.set(block.key, { section, block });
    }
  }
  const chunks = new Map(narration.chunks.map((c) => [c.id, c]));
  const takes = new Map(narration.takes.map((t) => [t.id, t]));
  const blockWords = new Map<string, ReturnType<typeof wordSpans>>();
  const wordsOf = (b: DraftBlock) => {
    let w = blockWords.get(b.key);
    if (!w) blockWords.set(b.key, (w = wordSpans(b.text)));
    return w;
  };
  const sentenceOf = new Map<string, number[]>();

  const words: SpineWord[] = [];
  const seen = new Map<string, Set<number>>();
  const unaligned: string[] = [];
  narration.entries.forEach((e, entryIndex) => {
    const chunk = chunks.get(e.chunkId);
    const take = takes.get(e.generationId);
    if (!chunk || !take) {
      fail(`clip ${entryIndex + 1}: its chunk or take is not in the narration`);
      return;
    }
    const aligned = take.alignment !== null && take.alignment.words.length > 0;
    if (!aligned) unaligned.push(take.id);
    let partStart = 0;
    for (const span of chunk.spans) {
      const length = span.end - span.start;
      const located = byKey.get(span.blockKey);
      if (!located) {
        fail(`clip ${entryIndex + 1} narrates block ${span.blockKey}, which is not in the script`);
        partStart += length + 1;
        continue;
      }
      const { block } = located;
      if (span.blockId !== block.rowId) fail(`block ${block.key}: the narration was made from another version or language of it`);
      if (chunk.sourceText.slice(partStart, partStart + length) !== block.text.slice(span.start, span.end)) fail(`block ${block.key}: the narrated text differs from the script's`);
      const bw = wordsOf(block);
      let sents = sentenceOf.get(block.key);
      if (!sents) {
        const spans = sentenceSpans(block.text);
        sents = bw.map((w) => {
          const i = spans.findIndex((s) => w.start >= s.start && w.start < s.end);
          return i >= 0 ? i : Math.max(0, spans.filter((s) => s.start <= w.start).length - 1);
        });
        sentenceOf.set(block.key, sents);
      }
      const timedAt = new Map<number, { startMs: number; endMs: number }>();
      if (aligned) {
        for (const w of take.alignment!.words) {
          if (w.start < partStart || w.end > partStart + length) continue;
          const offset = span.start + (w.start - partStart);
          const index = bw.findIndex((x) => x.start === offset);
          if (index < 0) {
            fail(`block ${block.key}: a timed word ("${w.word}") is not a word of the block`);
            continue;
          }
          timedAt.set(index, { startMs: e.startMs + w.startMs, endMs: e.startMs + w.endMs });
        }
      }
      const used = seen.get(block.key) ?? new Set<number>();
      seen.set(block.key, used);
      bw.forEach((w, i) => {
        if (w.start < span.start || w.end > span.end) return;
        if (used.has(i)) fail(`block ${block.key}: word ${i} is narrated twice`);
        used.add(i);
        const t = timedAt.get(i);
        words.push({
          index: words.length,
          blockKey: block.key,
          blockId: block.rowId!,
          word: i,
          text: w.word,
          start: w.start,
          end: w.end,
          sentence: sents![i]!,
          startMs: t?.startMs ?? 0,
          endMs: t?.endMs ?? 0,
          timed: t !== undefined,
          heard: { startMs: t?.startMs ?? 0, endMs: t?.endMs ?? 0 },
          entry: entryIndex,
          takeId: take.id,
          chunkId: chunk.id,
        });
      });
      partStart += length + 1;
    }
  });

  // Every block of the run's scope is narrated, every word once.
  for (const key of narration.run.scopeBlockKeys) {
    const located = byKey.get(key);
    if (!located) {
      fail(`block ${key} of the narration's scope is not in the script`);
      continue;
    }
    const used = seen.get(key);
    const total = wordsOf(located.block).length;
    if (!used || used.size !== total) fail(`block ${key} is not narrated in full (${used?.size ?? 0} of ${total} words)`);
  }
  // Words are heard in order.
  let lastStart = -1;
  for (const w of words) {
    if (!w.timed) continue;
    if (w.startMs < lastStart) fail(`block ${w.blockKey}: word ${w.word} is heard before the word ahead of it`);
    lastStart = w.startMs;
  }
  // The stored timeline holds the same word times (a cross-check against the frozen assembly).
  for (const part of narration.timeline) {
    const mine = words.filter((w) => w.timed && w.blockKey === part.scriptBlock.key && w.takeId === part.audioChunk.generationId);
    const same = mine.length === part.words.length && mine.every((w, i) => w.startMs === part.words[i]!.startMs && w.endMs === part.words[i]!.endMs);
    if (!same) fail(`block ${part.scriptBlock.key}: the word times differ from the assembly's stored timeline`);
  }
  if (issues.length) throw new SpineIntegrityError(`The narration cannot time this script: ${issues.slice(0, 3).join('; ')}${issues.length > 3 ? `; and ${issues.length - 3} more` : ''}`);

  const total = narration.assembly.totalDurationMs;
  const entries = narration.entries;
  interpolate(words, entries);

  // Blocks and sections in scope order.
  const blocks: SpineBlock[] = [];
  for (const w of words) {
    const last = blocks.at(-1);
    if (last && last.key === w.blockKey) {
      last.last = w.index;
      continue;
    }
    const { section, block } = byKey.get(w.blockKey)!;
    blocks.push({ id: block.rowId!, key: block.key, sectionKey: section.key, sequence: section.sequence, sceneId: section.rowId!, block, first: w.index, last: w.index, startMs: 0, endMs: 0 });
  }
  for (const b of blocks) {
    b.startMs = words[b.first]!.heard.startMs;
    b.endMs = words[b.last]!.heard.endMs;
  }
  const sections: SpineSection[] = [];
  for (const b of blocks) {
    if (sections.at(-1)?.key === b.sectionKey) continue;
    const s = byKey.get(b.key)!.section;
    sections.push({ key: s.key, sequence: s.sequence, sceneId: s.rowId!, title: s.title });
  }
  const inScope = new Set(blocks.map((b) => b.key));
  const outOfScope = script.sections.flatMap((s) => s.blocks).filter((b) => !inScope.has(b.key));

  const points = cutPoints(words, entries, total, byKey);
  const byId = new Map<string, CutPoint>();
  for (const p of points) for (const id of [p.id, ...p.aliases]) byId.set(id, p);
  const byPosition = new Map(points.map((p) => [p.position, p]));
  const blockByKey = new Map(blocks.map((b) => [b.key, b]));
  return {
    narration,
    totalDurationMs: total,
    blocks,
    sections,
    words,
    silences: silences(words, entries, total),
    points,
    unalignedTakes: [...new Set(unaligned)],
    outOfScope,
    point: (id) => byId.get(id),
    at: (position) => byPosition.get(position),
    block: (key) => blockByKey.get(key),
  };
}

/** Display times for untimed words: spread evenly between their timed neighbours in the same clip (never used for a cut or a stored time; `heard` keeps the real bounds). */
function interpolate(words: SpineWord[], entries: NarrationSpine['entries']): void {
  let i = 0;
  while (i < words.length) {
    if (words[i]!.timed) {
      i++;
      continue;
    }
    let j = i;
    while (j < words.length && !words[j]!.timed && words[j]!.entry === words[i]!.entry) j++;
    const entry = entries[words[i]!.entry]!;
    const before = i > 0 && words[i - 1]!.entry === words[i]!.entry ? words[i - 1]!.endMs : entry.startMs;
    const after = j < words.length && words[j]!.entry === words[i]!.entry ? words[j]!.startMs : entry.endMs;
    const step = Math.max(0, after - before) / (j - i);
    for (let k = i; k < j; k++) {
      words[k]!.startMs = Math.round(before + step * (k - i));
      words[k]!.endMs = Math.round(before + step * (k - i + 1));
      words[k]!.heard = { startMs: before, endMs: after };
    }
    i = j;
  }
}

function cutPoints(words: readonly SpineWord[], entries: NarrationSpine['entries'], total: number, byKey: ReadonlyMap<string, Located>): CutPoint[] {
  if (words.length === 0) return [];
  const first = words[0]!;
  const last = words.at(-1)!;
  const sectionOf = (key: string) => byKey.get(key)!.section.key;
  const out: CutPoint[] = [];
  const startEdge = first.timed ? first.startMs : entries[first.entry]!.startMs;
  out.push({ id: SCOPE_START, aliases: [`${first.blockKey}:0`], position: 0, kind: 'SCOPE_EDGE', blockKey: null, silence: { startMs: 0, endMs: startEdge }, atMs: 0, midSentence: false, clipEdge: !first.timed });
  for (let p = 1; p < words.length; p++) {
    const l = words[p - 1]!;
    const r = words[p]!;
    const sameClip = l.entry === r.entry;
    if (sameClip && !(l.timed && r.timed)) continue;
    const a = l.timed ? l.endMs : entries[l.entry]!.endMs;
    const b = r.timed ? r.startMs : entries[r.entry]!.startMs;
    const silence = { startMs: Math.min(a, b), endMs: Math.max(a, b) };
    let kind: CutPointKind | null;
    if (l.blockKey !== r.blockKey) kind = sectionOf(l.blockKey) !== sectionOf(r.blockKey) ? 'SECTION' : 'BLOCK';
    else if (l.sentence !== r.sentence) kind = 'SENTENCE';
    else if (isClause(byKey.get(l.blockKey)!.block.text.slice(l.end, r.start), r, words)) kind = 'CLAUSE';
    else if (!sameClip || silence.endMs - silence.startMs >= PAUSE_CUT_MS) kind = 'PAUSE';
    else kind = null;
    if (!kind) continue;
    const boundary = kind === 'SECTION' || kind === 'BLOCK';
    out.push({
      id: boundary ? `${l.blockKey}:end` : `${r.blockKey}:${r.word}`,
      aliases: boundary ? [`${r.blockKey}:0`] : [],
      position: p,
      kind,
      blockKey: boundary ? l.blockKey : r.blockKey,
      silence,
      atMs: Math.round(silence.startMs + (silence.endMs - silence.startMs) / 2),
      midSentence: kind === 'CLAUSE' || kind === 'PAUSE',
      clipEdge: !sameClip,
    });
  }
  const endEdge = last.timed ? last.endMs : entries[last.entry]!.endMs;
  out.push({ id: SCOPE_END, aliases: [`${last.blockKey}:end`], position: words.length, kind: 'SCOPE_EDGE', blockKey: null, silence: { startMs: endEdge, endMs: total }, atMs: total, midSentence: false, clipEdge: !last.timed });
  return out;
}

/** A comma, semicolon, colon or dash between two words of a sentence, with at least three words of the sentence after it. */
function isClause(between: string, r: SpineWord, words: readonly SpineWord[]): boolean {
  if (!CLAUSE_MARK.test(between)) return false;
  let after = 0;
  for (let i = r.index; i < words.length && words[i]!.blockKey === r.blockKey && words[i]!.sentence === r.sentence; i++) after++;
  return after >= CLAUSE_MIN_WORDS;
}

/**
 * Silences longer than SILENCE_MIN_MS: before the first word, between timed
 * words, between clips, after the last. Around an untimed word nothing is
 * known, so nothing is listed there.
 */
function silences(words: readonly SpineWord[], entries: NarrationSpine['entries'], total: number): { startMs: number; endMs: number }[] {
  const out: { startMs: number; endMs: number }[] = [];
  const add = (a: number, b: number) => {
    if (b - a > SILENCE_MIN_MS) out.push({ startMs: a, endMs: b });
  };
  const soundEnd = (w: SpineWord) => (w.timed ? w.endMs : entries[w.entry]!.endMs);
  let edge = 0;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const newClip = !prev || prev.entry !== w.entry;
    if (newClip && prev) edge = soundEnd(prev);
    if (w.timed) {
      if (newClip || prev!.timed) add(edge, w.startMs);
      edge = w.endMs;
    } else if (newClip) add(edge, entries[w.entry]!.startMs);
  });
  const last = words.at(-1);
  add(last ? soundEnd(last) : 0, total);
  return out;
}
