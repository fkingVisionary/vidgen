import { createHash } from 'node:crypto';
import { NarrationSpine, narrationFingerprintText, type AssemblyEntry, type NarrationAlignment, type NarrationTimelineEntry } from '@docengine/core';
import type { Prisma } from '@docengine/database';
import { describe, expect, it } from 'vitest';
import { assemble } from './assembly.ts';
import { SpineError, narrationFingerprint, spineOf, type SpineRows } from './spine.ts';
import { syntheticAssembly, syntheticChunk, type SyntheticBlock } from './testing.ts';
import { wordSpans } from './text.ts';

/**
 * The narration spine as the storyboard reads it from the voice engine's
 * rows: the entries, the chunks' spans and text, and the takes the entries
 * name; strict, never a silent default; and the fingerprint that tells one
 * narration from another.
 */

const BLOCKS: SyntheticBlock[] = [
  { key: '1.1', sectionKey: 'SC01', text: 'The bulbs arrive in spring.' },
  { key: '1.2', sectionKey: 'SC01', text: 'Prices climb. Nobody sells.' },
  { key: '1.3', sectionKey: 'SC01', text: 'Then the auction, in a tavern.' },
  { key: '2.1', sectionKey: 'SC02', text: 'The courts step in.' },
];
const TEXT = new Map(BLOCKS.map((b) => [b.key, b.text]));

/** Two blocks in one chunk, block 1.2 split after "Prices climb.", "auction" never timestamped, a pause before "in", and block 2.1's take with no word timings. */
const narration = () => syntheticAssembly(BLOCKS, { chunks: [['1.1', '1.2'], ['1.3'], ['2.1']], split: { '1.2': 2 }, untimed: ['1.3:2'], pauses: { '1.3:3': 700 }, missingAlignment: ['2.1'] });

/** Each timed word of a spine mapped back to its block through its chunk's spans: "<blockKey>:<wordIndex> <word> <absolute ms>". */
function wordsOnTheClock(s: NarrationSpine): string[] {
  const out: string[] = [];
  for (const e of s.entries) {
    const chunk = s.chunks.find((c) => c.id === e.chunkId)!;
    const take = s.takes.find((t) => t.id === e.generationId)!;
    for (const w of take.alignment?.words ?? []) {
      let at = 0;
      for (const span of chunk.spans) {
        if (w.start >= at && w.end <= at + span.end - span.start) {
          const offset = span.start + (w.start - at);
          const index = wordSpans(TEXT.get(span.blockKey)!).findIndex((b) => b.start === offset);
          out.push(`${span.blockKey}:${index} ${w.word} ${e.startMs + w.startMs}`);
        }
        at += span.end - span.start + 1;
      }
    }
  }
  return out;
}

/** Rows to change in a test. */
type Rows = Omit<SpineRows, 'chunks' | 'takes'> & { chunks: SpineRows['chunks'][number][]; takes: SpineRows['takes'][number][] };
type Change = (r: Rows) => void;

/** A copy of the rows with one part changed. */
function edit(rows: SpineRows, change: Change): SpineRows {
  const copy: Rows = structuredClone({ ...rows, chunks: [...rows.chunks], takes: [...rows.takes] });
  change(copy);
  return copy;
}
const json = (v: unknown) => v as Prisma.JsonValue;

describe('narration spine', () => {
  it('reads several blocks in one chunk, a block split over two chunks, an untimed word and a take without word timings', () => {
    const { spine: s, result } = narration();
    expect(NarrationSpine.parse(s)).toEqual(s);
    expect(s.assembly).toMatchObject({ version: 1, status: 'IN_REVIEW', complete: false, totalDurationMs: result.totalDurationMs, languageVersionId: 'language-1', fingerprint: narrationFingerprint(result.entries) });
    expect(s.run).toEqual({ id: 'run-1', number: 1, kind: 'AUDITION', scopeBlockKeys: ['1.1', '1.2', '1.3', '2.1'] });
    expect(s.entries).toEqual(result.entries);
    expect(s.timeline).toEqual(result.timeline);
    // The chunks as stored: spans (character ranges of the blocks) and the canonical text, one line break between blocks.
    expect(s.chunks.map((c) => [c.index, c.spans.map((p) => `${p.blockKey}[${p.start},${p.end})`).join(' + '), c.sourceText])).toEqual([
      [0, '1.1[0,27) + 1.2[0,13)', 'The bulbs arrive in spring.\nPrices climb.'],
      [1, '1.2[14,27)', 'Nobody sells.'],
      [2, '1.3[0,30)', 'Then the auction, in a tavern.'],
      [3, '2.1[0,19)', 'The courts step in.'],
    ]);
    // Every timed word lands on its block's word, on the assembled clock: block 1.2 continues in the next chunk at word 2,
    // "auction" (1.3:2) has no timestamp, "in" comes 700 ms late, and 2.1 has none at all.
    const [c0, c1, c2] = s.entries;
    expect(wordsOnTheClock(s)).toEqual([
      '1.1:0 The 200',
      '1.1:1 bulbs 600',
      '1.1:2 arrive 1000',
      '1.1:3 in 1400',
      '1.1:4 spring 1800',
      '1.2:0 Prices 2200',
      '1.2:1 climb 2600',
      `1.2:2 Nobody ${c1!.startMs + 200}`,
      `1.2:3 sells ${c1!.startMs + 600}`,
      `1.3:0 Then ${c2!.startMs + 200}`,
      `1.3:1 the ${c2!.startMs + 600}`,
      `1.3:3 in ${c2!.startMs + 1000 + 400 + 700}`,
      `1.3:4 a ${c2!.startMs + 2500}`,
      `1.3:5 tavern ${c2!.startMs + 2900}`,
    ]);
    expect(c0!.endMs).toBe(3200);
    const take = (i: number) => s.takes.find((t) => t.id === s.entries[i]!.generationId)!;
    expect(take(2).alignment).toMatchObject({ source: 'PROVIDER', unmatchedWords: 1 });
    // No word timings: the take is still heard (its clip edges are real audio); its words are never invented.
    expect(take(3)).toMatchObject({ alignment: null, durationMs: 2000, audioAssetId: 'a3' });
    expect(s.entries[3]).toMatchObject({ startMs: result.totalDurationMs - 2000, endMs: result.totalDurationMs });
    expect(s.takes.map((t) => [t.id, t.chunkId, t.status, t.mock, t.qaBlocking])).toEqual([
      ['g0', 'c0', 'IN_REVIEW', false, false],
      ['g1', 'c1', 'IN_REVIEW', false, false],
      ['g2', 'c2', 'IN_REVIEW', false, false],
      ['g3', 'c3', 'IN_REVIEW', false, false],
    ]);
  });

  it('reads the takes the entries name, never the chunks\' current takes', () => {
    const { rows } = narration();
    // Chunk 2 was regenerated after this assembly was built: its current take is a newer one of another length.
    const newer = { ...rows.takes[1]!, id: 'g1-2', generation: 2, durationMs: 1500, status: 'IN_REVIEW' as const };
    const after = edit(rows, (r) => {
      r.takes[1] = { ...r.takes[1]!, status: 'SUPERSEDED' };
      r.takes.push(newer);
      r.chunks[1] = { ...r.chunks[1]!, currentGenerationId: newer.id };
    });
    const s = spineOf(after);
    expect(s.takes.map((t) => [t.id, t.status, t.durationMs])).toEqual([
      ['g0', 'IN_REVIEW', 3200],
      ['g1', 'SUPERSEDED', 1200],
      ['g2', 'IN_REVIEW', 3500],
      ['g3', 'IN_REVIEW', 2000],
    ]);
    // A current take made before takes were reviewed (GENERATED) is to review; one that is not current keeps its status.
    expect(spineOf(edit(rows, (r) => (r.takes[0] = { ...r.takes[0]!, status: 'GENERATED' }))).takes[0]!.status).toBe('IN_REVIEW');
    expect(spineOf(edit(after, (r) => (r.takes[1] = { ...r.takes[1]!, status: 'GENERATED' }))).takes[1]!.status).toBe('GENERATED');
  });

  it('marks mock audio or timings, and takes with a blocking QA finding', () => {
    const { rows } = narration();
    const s = spineOf(
      edit(rows, (r) => {
        r.takes[0] = { ...r.takes[0]!, audioAsset: { isMock: true } };
        r.takes[1] = { ...r.takes[1]!, alignment: json({ ...(r.takes[1]!.alignment as unknown as NarrationAlignment), source: 'MOCK' }) };
        // No audio file row to ask: the provider says.
        r.takes[2] = { ...r.takes[2]!, audioAsset: null, provider: 'mock', qa: json([{ kind: 'DURATION_ANOMALY', severity: 'BLOCKING', ref: '#3', detail: 'far outside narration pace (test)' }]) };
        r.takes[3] = { ...r.takes[3]!, qa: json([{ kind: 'MISSING_ALIGNMENT', severity: 'WARNING', ref: '#4', detail: 'no timestamps (test)' }]) };
      }),
    );
    expect(s.takes.map((t) => [t.mock, t.qaBlocking])).toEqual([
      [true, false],
      [true, false],
      [true, true],
      [false, false],
    ]);
    expect(syntheticAssembly(BLOCKS, { mock: true }).spine.takes.every((t) => t.mock && t.alignment?.source === 'MOCK')).toBe(true);
  });

  it('gives assemblies made before audio files were recorded in them the takes\' files, with the same fingerprint', () => {
    const { rows, spine } = narration();
    const bare = edit(rows, (r) => {
      r.assembly = {
        ...r.assembly,
        entries: json((r.assembly.entries as unknown as AssemblyEntry[]).map(({ audioAssetId: _, ...e }) => e)),
        timeline: json((r.assembly.timeline as unknown as NarrationTimelineEntry[]).map(({ audioChunk: { audioAssetId: _, ...chunk }, ...t }) => ({ ...t, audioChunk: chunk }))),
      };
    });
    const s = spineOf(bare);
    expect(s.entries.map((e) => e.audioAssetId)).toEqual(['a0', 'a1', 'a2', 'a3']);
    expect(s.timeline.map((t) => t.audioChunk.audioAssetId)).toEqual(['a0', 'a0', 'a1', 'a2', 'a3']);
    expect(s.assembly.fingerprint).toBe(spine.assembly.fingerprint);
  });

  it('refuses rows it cannot read or that do not belong together, never reading them as empty or null', () => {
    const { rows } = narration();
    const chunk = (i: number, c: Partial<Rows['chunks'][number]>): Change => (r) => void (r.chunks[i] = { ...r.chunks[i]!, ...c });
    const take = (i: number, t: Partial<Rows['takes'][number]>): Change => (r) => void (r.takes[i] = { ...r.takes[i]!, ...t });
    const entries = rows.assembly.entries as unknown as AssemblyEntry[];
    const clips = (change: (e: AssemblyEntry, i: number) => AssemblyEntry): Change => (r) => void (r.assembly = { ...r.assembly, entries: json(entries.map(change)) });
    // The fixture's clips: [0, 3200) gap 0, [3200, 4400) gap 10, [4410, 7910) gap 760, [8670, 10670); chunk 3 reads "Then the auction, in a tavern."
    expect(entries.map((e) => [e.startMs, e.endMs, e.gapAfterMs])).toEqual([
      [0, 3200, 0],
      [3200, 4400, 10],
      [4410, 7910, 760],
      [8670, 10670, 0],
    ]);
    const words = (rows.takes[2]!.alignment as unknown as NarrationAlignment).words;
    const cases: [string, Change, RegExp][] = [
      ['an entry naming its chunk by another place', clips((e, i) => (i === 1 ? { ...e, chunkIndex: 5 } : e)), /^Assembly v1 of voice run 1, chunk 6: the run has this chunk as chunk 2 of section SC01$/],
      ['an entry naming its chunk by another section', clips((e, i) => (i === 1 ? { ...e, sectionKey: 'SC02' } : e)), /^Assembly v1 of voice run 1, chunk 2: the run has this chunk as chunk 2 of section SC01$/],
      ['a chunk heard twice', clips((e, i) => (i === 2 ? { ...entries[1]!, startMs: e.startMs, endMs: e.startMs + 1200 } : e)), /^Assembly v1 of voice run 1, chunk 2: the clip comes after chunk 2's \(clips are in chunk order, each chunk once\)$/],
      [
        'clips out of chunk order',
        (r) => void (r.assembly = { ...r.assembly, entries: json([entries[0], entries[1], { ...entries[3]!, startMs: 4410, endMs: 6410 }, { ...entries[2]!, startMs: 6410, endMs: 9910 }]) }),
        /^Assembly v1 of voice run 1, chunk 3: the clip comes after chunk 4's \(clips are in chunk order, each chunk once\)$/,
      ],
      ['overlapping clips', clips((e, i) => (i === 2 ? { ...e, startMs: e.startMs - 300, endMs: e.endMs - 300 } : e)), /^Assembly v1 of voice run 1, chunk 3: the clip starts at 4110 ms, where the narration before it ends at 4410 ms$/],
      ['a silence no pause accounts for', clips((e, i) => (i === 1 ? { ...e, gapAfterMs: 0 } : e)), /^Assembly v1 of voice run 1, chunk 3: the clip starts at 4410 ms, where the narration before it ends at 4400 ms$/],
      ['narration that does not start at 0', clips((e) => ({ ...e, startMs: e.startMs + 100, endMs: e.endMs + 100 })), /^Assembly v1 of voice run 1, chunk 1: the clip starts at 100 ms, where the narration starts at 0 ms$/],
      ['a length that is not its clips\'', (r) => void (r.assembly = { ...r.assembly, totalDurationMs: 11_000 }), /^Assembly v1 of voice run 1: it lasts 11000 ms, its clips and pauses 10670 ms$/],
      [
        'word timings that are not the chunk\'s words',
        take(2, { alignment: json({ ...(rows.takes[2]!.alignment as unknown as NarrationAlignment), words: words.map((w) => (w.word === 'tavern' ? { ...w, start: w.start - 1, end: w.end - 1 } : w)) }) }),
        /^Assembly v1 of voice run 1, chunk 3: the word timings of take 1 do not fit the chunk's text \("tavern" at characters 22–28\)$/,
      ],
      ['entries that are not clips', (r) => void (r.assembly = { ...r.assembly, entries: json('nonsense') }), /^Assembly v1 of voice run 1: its clips cannot be read \(value: /],
      ['no entries', (r) => void (r.assembly = { ...r.assembly, entries: json([]) }), /^Assembly v1 of voice run 1: its clips cannot be read \(value: no clips\)$/],
      ['a malformed timeline', (r) => void (r.assembly = { ...r.assembly, timeline: json([{ startMs: 0 }]) }), /^Assembly v1 of voice run 1: its timeline cannot be read \(0\.scriptBlock: /],
      ['a scope without its block keys', (r) => void (r.run = { ...r.run, scope: json({ kind: 'AUDITION' }) }), /^Voice run 1: its scope cannot be read \(blockKeys: /],
      ['malformed spans', chunk(1, { spans: json([{ blockKey: '1.2' }]) }), /^Chunk 2 of voice run 1: its spans cannot be read \(0\.blockId: /],
      ['a chunk text that is not its spans', chunk(1, { sourceText: 'Nobody sells it.' }), /^Chunk 2 of voice run 1: its text \(16 characters\) is not its spans \(13\)$/],
      ['malformed word timings', take(2, { alignment: json({ source: 'PROVIDER', words: 'x', characters: null, unmatchedWords: 0 }) }), /^Assembly v1 of voice run 1, chunk 3: the word timings of take 1 cannot be read \(words: /],
      ['malformed take QA', take(2, { qa: json([{ kind: 'NOT_A_KIND', severity: 'BLOCKING', ref: null, detail: '' }]) }), /^Assembly v1 of voice run 1, chunk 3: the QA of take 1 cannot be read \(0\.kind: /],
      ['an entry whose take is gone', (r) => void r.takes.splice(1, 1), /^Assembly v1 of voice run 1, chunk 2: take g1 is missing$/],
      ['an entry naming another chunk\'s take', take(1, { chunkId: 'c0' }), /^Assembly v1 of voice run 1, chunk 2: take 1 is another chunk's$/],
      ['a take of other text', take(1, { textHash: '0'.repeat(64) }), /^Assembly v1 of voice run 1, chunk 2: take 1 was made from other text than the chunk's$/],
      ['a clip of another length', take(1, { durationMs: 1300 }), /^Assembly v1 of voice run 1, chunk 2: the clip lasts 1200 ms in the assembly, take 1 measures 1300$/],
      ['a take with no measured length', take(1, { durationMs: null }), /take 1 measures nothing$/],
      ['an entry of a chunk outside the run', (r) => void (r.assembly = { ...r.assembly, entries: json(entries.map((e, i) => (i === 3 ? { ...e, chunkId: 'elsewhere' } : e))) }), /^Assembly v1 of voice run 1, chunk 4: the chunk is not in the run$/],
      ['an assembly of another run', (r) => void (r.assembly = { ...r.assembly, runId: 'run-2' }), /^Assembly v1 of voice run 1 belongs to another run$/],
    ];
    expect(() => spineOf(rows)).not.toThrow();
    for (const [what, change, message] of cases) {
      const attempt = () => spineOf(edit(rows, change));
      expect(attempt, what).toThrow(SpineError);
      expect(attempt, what).toThrow(message);
    }
  });
});

describe('narration fingerprint', () => {
  const blocks = BLOCKS.slice(0, 3);
  const built = (over: (c: ReturnType<typeof syntheticChunk>) => ReturnType<typeof syntheticChunk> = (c) => c) =>
    assemble(
      blocks.map((b, i) => over(syntheticChunk(i, b.sectionKey, [[b.key, b.text]]))),
      new Map(),
    ).entries;

  it('is the sha256 of the clips and their places, equal for identical entries whatever else differs', () => {
    const entries = built();
    const f = narrationFingerprint(entries);
    expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(f).toBe(createHash('sha256').update(narrationFingerprintText(entries), 'utf8').digest('hex'));
    // Rebuilt identically (a RESTORE back to the same takes makes a new assembly version with the same entries).
    expect(narrationFingerprint(built())).toBe(f);
    // What the fingerprint does not hash: the take's number, its audio file, the chunk's index, section and blocks.
    expect(narrationFingerprint(entries.map((e) => ({ ...e, generation: 7, audioAssetId: 'elsewhere', chunkIndex: 9, sectionKey: 'SC09', blockKeys: [] })))).toBe(f);
    // Two spines of identical entries under different assembly versions.
    const a = syntheticAssembly(BLOCKS);
    const b = syntheticAssembly(BLOCKS, { ids: { assembly: 'assembly-3' } });
    expect(b.spine.assembly.fingerprint).toBe(a.spine.assembly.fingerprint);
  });

  it('changes with another take of the same length (a RESTORE), and with any start, end or gap', () => {
    const f = narrationFingerprint(built());
    const restored = built((c) => (c.index === 1 ? { ...c, take: { ...c.take!, id: 'g1-restored' } } : c));
    expect(restored.map((e) => [e.startMs, e.endMs, e.gapAfterMs])).toEqual(built().map((e) => [e.startMs, e.endMs, e.gapAfterMs]));
    expect(narrationFingerprint(restored)).not.toBe(f);
    expect(narrationFingerprint(built((c) => (c.index === 1 ? { ...c, take: { ...c.take!, durationMs: c.take!.durationMs + 40 } } : c)))).not.toBe(f);
    expect(narrationFingerprint(built((c) => (c.index === 0 ? { ...c, pauses: { ...c.pauses, after: 'LONG' } } : c)))).not.toBe(f);
    expect(narrationFingerprint(built().slice(0, 2))).not.toBe(f);
  });
});
