import { describe, expect, it } from 'vitest';
import { comparisonRow, comparisonText, durationStats, type RunLine } from './summary.ts';

/** The pure parts of a VOICE job's log: duration statistics and the comparison table. */

const line = (over: Partial<RunLine>): RunLine => ({
  runId: 'r',
  run: 1,
  kind: 'AUDITION',
  experiment: 'Acceptance experiment',
  variant: 'B restrained',
  script: { id: 's', version: 5 },
  strategy: 'RESTRAINED',
  chunking: { minWords: 20, maxWords: 30 },
  context: { previousChars: 200, nextChars: 120, stitch: false },
  profile: { id: 'p', name: 'House narrator', version: 1 },
  provider: 'elevenlabs',
  model: 'eleven_v4',
  voiceId: 'v',
  language: 'en',
  outputFormat: 'mp3_44100_128',
  chunks: 9,
  takes: { IN_REVIEW: 9 },
  regenerations: 0,
  job: { takes: 9, characters: 1580, estimatedUsd: 0.0348 },
  characters: 1580,
  reportedCharacters: 1580,
  estimatedUsd: 0.0348,
  reportedUsd: null,
  costBases: ['ESTIMATED'],
  durations: durationStats([9800, 10_400, 11_000]),
  withTimestamps: 9,
  assembly: null,
  qa: { blocking: {}, warning: {} },
  pronunciation: { unresolved: [], used: [] },
  stopped: null,
  ...over,
});

describe('durationStats', () => {
  it('gives total, shortest, longest, mean and median of measured durations', () => {
    expect(durationStats([12_000, 8000, 10_000])).toEqual({ totalMs: 30_000, shortestMs: 8000, longestMs: 12_000, meanMs: 10_000, medianMs: 10_000 });
    expect(durationStats([8000, 9000, 11_000, 30_000])).toMatchObject({ meanMs: 14_500, medianMs: 10_000 });
  });

  it('says nothing was measured rather than inventing zeros', () => {
    expect(durationStats([])).toEqual({ totalMs: 0, shortestMs: null, longestMs: null, meanMs: null, medianMs: null });
  });
});

describe('comparison rows', () => {
  it('names each variant with its strategy, context and chunking, and what it measured and cost', () => {
    const row = comparisonRow(line({}));
    expect(row).toEqual({ variant: 'B restrained', run: 1, strategy: 'RESTRAINED', context: 'previous 200 / next 120 chars', chunking: '20–30 words', chunks: 9, totalMs: 31_200, meanChunkMs: 10_400, characters: 1580, estimatedUsd: 0.0348 });
    expect(comparisonText(row)).toBe('B restrained | RESTRAINED | context previous 200 / next 120 chars | 20–30 words | 9 chunks | 31.2 s | mean 10.4 s | 1580 chars | $0.0348');
  });

  it('tells no context, stitching and an unpriced run apart', () => {
    expect(comparisonRow(line({ context: { previousChars: 0, nextChars: 0, stitch: false } })).context).toBe('none');
    expect(comparisonRow(line({ context: { previousChars: 200, nextChars: 120, stitch: true } })).context).toBe('stitched');
    expect(comparisonText(comparisonRow(line({ estimatedUsd: null, durations: durationStats([]) })))).toMatch(/\| 0\.0 s \| mean – \| 1580 chars \| unpriced$/);
  });
});
