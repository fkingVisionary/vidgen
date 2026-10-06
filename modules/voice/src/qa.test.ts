import type { VoiceChunk, VoiceGeneration, VoiceGenerationStatus } from '@docengine/database';
import { describe, expect, it } from 'vitest';
import { takeQa } from './qa.ts';
import { assemblyMismatch, runQa, takeStatus, usableTake, type RunChunk } from './runs.ts';
import { toSpoken } from './spoken.ts';
import { wordSpans } from './text.ts';

/** Voice QA as it stands: the speaking rate, the current takes of a run, and the assembly against them. */

function take(id: string, over: Partial<VoiceGeneration> = {}): VoiceGeneration {
  return { id, generation: 1, status: 'IN_REVIEW', textHash: 'h', audioAssetId: `asset-${id}`, durationMs: 4000, qa: [], ...over } as VoiceGeneration;
}

function chunk(index: number, current: VoiceGeneration | null): RunChunk {
  return { id: `c${index}`, chunkIndex: index, textHash: 'h', blockKeys: [`1.${index + 1}`], blockHashes: {}, currentGenerationId: current?.id ?? null, current } as unknown as VoiceChunk & { current: VoiceGeneration | null };
}

const entry = (c: RunChunk, generationId: string) => ({ chunkId: c.id, chunkIndex: c.chunkIndex, generationId, generation: 1, sectionKey: 'SC01', blockKeys: c.blockKeys, startMs: 0, endMs: 1, gapAfterMs: 0 });

const qaOf = (chunks: RunChunk[]) => runQa({ kind: 'AUDITION', scriptVersion: 1, approved: { id: 's1', version: 1 }, scriptId: 's1', chunks, allBlockKeys: chunks.flatMap((c) => c.blockKeys), approvedBlockText: null, unresolved: [] });
const kinds = (fs: { kind: string; ref: string | null }[]) => fs.map((f) => `${f.kind} ${f.ref}`);

describe('speaking rate', () => {
  it('counts the words the voice says, not the written ones (a year or an amount is several spoken words)', () => {
    const canonical = 'In 1637 a single bulb sold for 5,200 guilders.';
    const spoken = toSpoken(canonical, { style: 'UK', aliases: [] }).text;
    // 9 written words, 13 spoken, over 6 s of speech: 90 a minute as written (slow), 130 as spoken.
    const words = wordSpans(canonical).map((w, i) => ({ word: w.word, start: w.start, end: w.end, startMs: 200 + i * 667, endMs: 200 + (i + 1) * 667 - 20 }));
    const qa = takeQa({ ref: '#1', canonical, durationMs: 6600, hasAudio: true, alignment: { source: 'PROVIDER', words, characters: null, unmatchedWords: 0 }, forms: [], spokenText: spoken, checks: [], mock: false });
    expect(qa.filter((f) => f.kind === 'DURATION_ANOMALY')).toEqual([]);
    // A rushed take is still caught on spoken words.
    const rushed = words.map((w, i) => ({ ...w, startMs: 100 + i * 180, endMs: 100 + (i + 1) * 180 - 10 }));
    expect(takeQa({ ref: '#1', canonical, durationMs: 1900, hasAudio: true, alignment: { source: 'PROVIDER', words: rushed, characters: null, unmatchedWords: 0 }, forms: [], spokenText: spoken, checks: [], mock: false }).map((f) => `${f.kind}:${f.severity}`)).toEqual(['DURATION_ANOMALY:BLOCKING']);
  });
});

describe('a run\'s current takes', () => {
  it('reads a take to review, or a current take made before IN_REVIEW existed, as not approved yet', () => {
    expect(kinds(qaOf([chunk(0, take('t0')), chunk(1, take('t1', { status: 'GENERATED' })), chunk(2, take('t2', { status: 'APPROVED' }))]))).toEqual(['TAKE_UNREVIEWED #1', 'TAKE_UNREVIEWED #2']);
    expect(takeStatus(take('t1', { status: 'GENERATED' }), 't1')).toBe('IN_REVIEW');
    // An A/B variant (not current) stays generated.
    expect(takeStatus(take('t1', { status: 'GENERATED' }), 't0')).toBe('GENERATED');
  });

  it('reports a current take whose audio is missing, once', () => {
    const lost = take('t0', { status: 'APPROVED', audioAssetId: null });
    expect(kinds(qaOf([chunk(0, lost)]))).toEqual(['MISSING_AUDIO #1']);
    const unmeasured = take('t0', { status: 'APPROVED', durationMs: null });
    expect(qaOf([chunk(0, unmeasured)])[0]!.detail).toMatch(/no stored audio of a measured length/);
    const recorded = take('t0', { status: 'APPROVED', audioAssetId: null, qa: [{ kind: 'MISSING_AUDIO', severity: 'BLOCKING', ref: '#1', detail: 'The take has no stored audio' }] });
    expect(kinds(qaOf([chunk(0, recorded)]))).toEqual(['MISSING_AUDIO #1']);
    // A take still being made has no audio yet: that is a pending take, not lost audio.
    expect(kinds(qaOf([chunk(0, take('t0', { status: 'PENDING', audioAssetId: null, durationMs: null }))]))).toEqual(['GENERATION_FAILED #1']);
  });

  it('places only takes with stored, measured audio that is to review or decided', () => {
    const statuses: VoiceGenerationStatus[] = ['PENDING', 'GENERATING', 'GENERATED', 'IN_REVIEW', 'FAILED', 'REJECTED', 'APPROVED', 'SUPERSEDED'];
    expect(statuses.filter((s) => usableTake(take('t', { status: s })))).toEqual(['GENERATED', 'IN_REVIEW', 'REJECTED', 'APPROVED']);
    expect(usableTake(take('t', { durationMs: 0 }))).toBe(false);
    expect(usableTake(null)).toBe(false);
  });
});

describe('the assembly against the current takes', () => {
  const chunks = [chunk(0, take('t0')), chunk(1, take('t1')), chunk(2, null)];

  it('agrees when every usable current take is assembled and nothing else is', () => {
    expect(assemblyMismatch(chunks, { version: 2, entries: [entry(chunks[0]!, 't0'), entry(chunks[1]!, 't1')] })).toBeNull();
    // No take anywhere and no assembly: nothing to compare.
    expect(assemblyMismatch([chunk(0, null)], null)).toBeNull();
  });

  it('blocks when the assembly holds another take, leaves a take out, or holds a chunk with no usable take', () => {
    expect(assemblyMismatch(chunks, { version: 2, entries: [entry(chunks[0]!, 't0'), entry(chunks[1]!, 'old')] })).toMatchObject({ kind: 'ASSEMBLY_MISMATCH', severity: 'BLOCKING', ref: '#2', detail: expect.stringMatching(/^Assembly v2 does not hold the current take of chunk\(s\) #2/) });
    expect(assemblyMismatch(chunks, { version: 2, entries: [entry(chunks[0]!, 't0')] })).toMatchObject({ ref: '#2' });
    expect(assemblyMismatch(chunks, { version: 2, entries: [entry(chunks[0]!, 't0'), entry(chunks[1]!, 't1'), entry(chunks[2]!, 'gone')] })).toMatchObject({ ref: '#3' });
    expect(assemblyMismatch(chunks, null)).toMatchObject({ ref: null, detail: expect.stringMatching(/^Chunk\(s\) #1, #2 have takes but the run has no assembly yet/) });
    // Unreadable entries are not the current takes either.
    expect(assemblyMismatch(chunks, { version: 1, entries: 'garbage' })).toMatchObject({ kind: 'ASSEMBLY_MISMATCH' });
  });
});
