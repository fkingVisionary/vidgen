import { DEFAULT_DELIVERY, type ChunkBoundary, type NarrationAlignment, type NarrationSpine, type ScriptVisual, type TimedWord, type VoiceGenerationStatus, type VoiceRunKind } from '@docengine/core';
import type { Prisma } from '@docengine/database';
import { assemble, type AssemblyBlock, type AssemblyChunk, type AssemblyResult } from './assembly.ts';
import { spineOf, type SpineRows } from './spine.ts';
import { sha256, wordSpans } from './text.ts';

/**
 * Narration for tests, with no database and no voice: takes whose words are
 * evenly spaced, chunks of script blocks, and a whole assembly on the
 * measured clock with the spine the storyboard reads from it — pauses inside
 * takes, several blocks in one chunk, a block split over two chunks, words
 * with no timestamp, and takes with no word timings at all.
 */

const NO_VISUAL: ScriptVisual = { intent: 'NONE', mustShow: [], mustAvoid: [], priority: 'NORMAL', fictional: false, note: '' };

/** A take whose words start msPerWord apart and are each heard for 40 ms less, with 200 ms of silence before the first word and 240 ms after the last. */
export function syntheticTake(id: string, text: string, msPerWord = 400): NonNullable<AssemblyChunk['take']> {
  const words = wordSpans(text).map((w, i) => ({ word: w.word, start: w.start, end: w.end, startMs: 200 + i * msPerWord, endMs: 200 + i * msPerWord + msPerWord - 40 }));
  const alignment: NarrationAlignment = { source: 'PROVIDER', words, characters: null, unmatchedWords: 0 };
  return { id, generation: 1, durationMs: 400 + words.length * msPerWord, alignment };
}

/** A chunk narrating whole blocks ([key, text] each), with its take. */
export function syntheticChunk(index: number, sectionKey: string, parts: [string, string][], over: Partial<AssemblyChunk> = {}): AssemblyChunk {
  const text = parts.map((p) => p[1]).join('\n');
  return {
    id: `c${index}`,
    index,
    sectionKey,
    blockKeys: parts.map((p) => p[0]),
    spans: parts.map(([k, t]) => ({ blockId: `b${k}`, blockKey: k, start: 0, end: t.length })),
    text,
    boundary: 'PARAGRAPH',
    pauses: { before: 'NONE', after: 'NONE', inside: [] },
    take: syntheticTake(`g${index}`, text),
    ...over,
  };
}

/** A script block to narrate. */
export interface SyntheticBlock {
  key: string;
  sectionKey: string;
  text: string;
  /** The script block's id (default "b<key>"). */
  id?: string;
}

export interface SyntheticAssemblyOptions {
  /** Time each word takes (ms, default 400); it is heard for 40 ms less. */
  msPerWord?: number;
  /** Extra silence before a word, by "<blockKey>:<wordIndex>" (ms); before a chunk's first word it is silence at the start of its clip. */
  pauses?: Record<string, number>;
  /** Blocks narrated together, one list per chunk (default: a chunk per block). */
  chunks?: string[][];
  /** A block split over two chunks: the second starts at this word of the block. */
  split?: Record<string, number>;
  /** Words heard but never timestamped, by "<blockKey>:<wordIndex>" (unmatched). */
  untimed?: string[];
  /** Blocks whose chunks' takes have no word timings at all. */
  missingAlignment?: string[];
  /** Every take's status (default IN_REVIEW). */
  status?: VoiceGenerationStatus;
  /** Mock audio and timings (default: a provider's). */
  mock?: boolean;
  kind?: VoiceRunKind;
  /** The rows' ids (defaults "assembly-1", "run-1", "script-1", "profile-1", "language-1"). */
  ids?: Partial<Record<'assembly' | 'run' | 'script' | 'profile' | 'languageVersion', string>>;
}

export interface SyntheticAssembly {
  chunks: AssemblyChunk[];
  blocks: Map<string, AssemblyBlock>;
  result: AssemblyResult;
  /** The rows the voice engine would have stored. */
  rows: SpineRows;
  /** What the storyboard reads from them (with the same checks as from the database). */
  spine: NarrationSpine;
}

interface Part {
  block: SyntheticBlock;
  start: number;
  end: number;
}

/** A narrated assembly of these blocks, in order, built by the voice engine's own assemble(). */
export function syntheticAssembly(blocks: readonly SyntheticBlock[], o: SyntheticAssemblyOptions = {}): SyntheticAssembly {
  const msPerWord = o.msPerWord ?? 400;
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const groups = (o.chunks ?? blocks.map((b) => [b.key])).map((keys) =>
    keys.map((k) => {
      const block = byKey.get(k);
      if (!block) throw new Error(`syntheticAssembly: no block ${k}`);
      return block;
    }),
  );
  // Parts per chunk: whole blocks, each split block cut in two at its word (the chunk is cut there too).
  const parts: Part[][] = [];
  for (const group of groups) {
    let current: Part[] = [];
    for (const block of group) {
      const at = o.split?.[block.key];
      if (at === undefined) {
        current.push({ block, start: 0, end: block.text.length });
        continue;
      }
      const words = wordSpans(block.text);
      if (at <= 0 || at >= words.length) throw new Error(`syntheticAssembly: block ${block.key} has no word ${at} to split at`);
      const cut = words[at]!.start;
      current.push({ block, start: 0, end: block.text.slice(0, cut).trimEnd().length });
      parts.push(current);
      current = [{ block, start: cut, end: block.text.length }];
    }
    parts.push(current);
  }

  const untimed = new Set(o.untimed ?? []);
  const unaligned = new Set(o.missingAlignment ?? []);
  const status = o.status ?? 'IN_REVIEW';
  const chunks: AssemblyChunk[] = parts.map((ps, index) => {
    const sectionKey = ps[0]!.block.sectionKey;
    const text = ps.map((p) => p.block.text.slice(p.start, p.end)).join('\n');
    const words: TimedWord[] = [];
    let clock = 200;
    let unmatched = 0;
    let offset = 0;
    for (const p of ps) {
      const blockWords = wordSpans(p.block.text);
      for (const w of wordSpans(p.block.text.slice(p.start, p.end))) {
        const index = blockWords.findIndex((b) => b.start === p.start + w.start);
        const ref = `${p.block.key}:${index}`;
        clock += o.pauses?.[ref] ?? 0;
        if (untimed.has(ref)) unmatched++;
        else words.push({ word: w.word, start: offset + w.start, end: offset + w.end, startMs: clock, endMs: clock + msPerWord - 40 });
        clock += msPerWord;
      }
      offset += p.end - p.start + 1;
    }
    const next = parts[index + 1];
    const boundary: ChunkBoundary = !next ? 'SECTION_END' : next[0]!.block.sectionKey !== sectionKey ? 'SECTION_END' : next[0]!.start > 0 ? 'SENTENCE' : 'PARAGRAPH';
    const alignment: NarrationAlignment | null = ps.some((p) => unaligned.has(p.block.key)) ? null : { source: o.mock ? 'MOCK' : 'PROVIDER', words, characters: null, unmatchedWords: unmatched };
    return {
      id: `c${index}`,
      index,
      sectionKey,
      blockKeys: ps.map((p) => p.block.key),
      spans: ps.map((p) => ({ blockId: p.block.id ?? `b${p.block.key}`, blockKey: p.block.key, start: p.start, end: p.end })),
      text,
      boundary,
      pauses: { before: 'NONE', after: 'NONE', inside: [] },
      take: { id: `g${index}`, generation: 1, durationMs: clock + 200, alignment, audioAssetId: `a${index}` },
    };
  });
  const blockMap = new Map<string, AssemblyBlock>(blocks.map((b) => [b.key, { id: b.id ?? `b${b.key}`, key: b.key, delivery: DEFAULT_DELIVERY, visual: NO_VISUAL }]));
  const result = assemble(chunks, blockMap);

  const kind = o.kind ?? 'AUDITION';
  const json = (v: unknown) => v as Prisma.JsonValue;
  const ids = { assembly: 'assembly-1', run: 'run-1', script: 'script-1', profile: 'profile-1', languageVersion: 'language-1', ...o.ids };
  const rows: SpineRows = {
    assembly: { id: ids.assembly, runId: ids.run, version: 1, status: 'IN_REVIEW', complete: kind === 'FULL', totalDurationMs: result.totalDurationMs, profileId: ids.profile, scriptId: ids.script, entries: json(result.entries), timeline: json(result.timeline) },
    run: { id: ids.run, number: 1, kind, scope: json({ kind, description: 'Synthetic narration (test)', blockKeys: blocks.map((b) => b.key) }), languageVersionId: ids.languageVersion },
    chunks: chunks.map((c) => ({ id: c.id, chunkIndex: c.index, sectionKey: c.sectionKey, spans: json(c.spans), sourceText: c.text, textHash: sha256(c.text), currentGenerationId: c.take!.id })),
    takes: chunks.map((c) => ({
      id: c.take!.id,
      chunkId: c.id,
      generation: 1,
      status,
      provider: o.mock ? 'mock' : 'acme-voice',
      textHash: sha256(c.text),
      durationMs: c.take!.durationMs,
      alignment: json(c.take!.alignment),
      audioAssetId: c.take!.audioAssetId!,
      qa: json([]),
      audioAsset: { isMock: !!o.mock },
    })),
  };
  return { chunks, blocks: blockMap, result, rows, spine: spineOf(rows) };
}
