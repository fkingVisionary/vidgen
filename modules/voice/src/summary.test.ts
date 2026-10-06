import { MockVoiceProvider, type ProviderInfo } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import { costText, sumReported, takeCost, type LedgerRow } from './cost.ts';
import { comparisonRow, comparisonText, durationStats, type RunLine } from './summary.ts';

/** The pure parts of a VOICE job's log: duration statistics, the comparison table and what a take cost. */

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
  profile: { familyId: 'f', family: 'House narrator', versionId: 'p', version: 1, name: 'House narrator' },
  configuration: { reconstructed: true, selection: null, projectOverrides: {}, runOptions: {}, provenance: {}, overrides: 'none' },
  effective: { providerSettings: {}, sent: {}, ignored: [], numberStyle: 'UK', performanceRules: {} as RunLine['effective']['performanceRules'], pronunciation: { rules: [] } },
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
  providerReported: [{ name: 'character-cost', total: 174, requests: 9 }],
  costText: 'sent 1,580 characters; provider reported 174 (character-cost header)',
  estimatedUsd: 0.0348,
  reportedUsd: null,
  reestimated: false,
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
  it('names each variant with its profile, strategy, context and chunking, and what it measured and cost', () => {
    const row = comparisonRow(line({ configuration: { reconstructed: false, selection: { mode: 'DEFAULT', revision: 0 }, projectOverrides: {}, runOptions: { strategy: 'RESTRAINED', chunking: { minWords: 20, maxWords: 30 } }, provenance: {}, overrides: '' } }));
    expect(row).toEqual({ variant: 'B restrained', run: 1, profile: 'House narrator v1', strategy: 'RESTRAINED', context: 'previous 200 / next 120 chars', chunking: '20–30 words', overrides: 'none', chunks: 9, totalMs: 31_200, meanChunkMs: 10_400, characters: 1580, estimatedUsd: 0.0348 });
    expect(comparisonText(row)).toBe('B restrained | House narrator v1 | RESTRAINED | context previous 200 / next 120 chars | 20–30 words | 9 chunks | 31.2 s | mean 10.4 s | 1580 chars | $0.0348');
  });

  it('shows what else a variant set (the project\'s overrides too), and a renamed profile by both names', () => {
    const row = comparisonRow(
      line({
        variant: 'C warmer',
        profile: { familyId: 'f', family: 'Classic narrator', versionId: 'p', version: 2, name: 'Tulip narrator' },
        configuration: { reconstructed: false, selection: { mode: 'FOLLOW', revision: 3 }, projectOverrides: { providerSettings: { stability: 0.4 } }, runOptions: { strategy: 'EXPRESSIVE', providerSettings: { similarity: 0.9 } }, provenance: {}, overrides: '' },
      }),
    );
    expect(row).toMatchObject({ profile: 'Tulip narrator v2 (now Classic narrator)', overrides: 'stability 0.4, similarity 0.9' });
    expect(comparisonText(row)).toMatch(/^C warmer \| Tulip narrator v2 \(now Classic narrator\) \| RESTRAINED \| context previous 200 \/ next 120 chars \| 20–30 words \| overrides stability 0\.4, similarity 0\.9 \| 9 chunks/);
  });

  it('tells no context, stitching and an unpriced run apart', () => {
    expect(comparisonRow(line({ context: { previousChars: 0, nextChars: 0, stitch: false } })).context).toBe('none');
    expect(comparisonRow(line({ context: { previousChars: 200, nextChars: 120, stitch: true } })).context).toBe('stitched');
    expect(comparisonText(comparisonRow(line({ estimatedUsd: null, durations: durationStats([]) })))).toMatch(/\| 0\.0 s \| mean – \| 1580 chars \| unpriced$/);
  });
});

describe('what a take cost', () => {
  const rates: ProviderInfo['rates'] = [{ provider: 'elevenlabs', model: 'eleven_v4', unit: 'CHARACTERS', usdPerUnit: 0.00008, source: 'rate card (test)' }];
  const provider = { info: { ...new MockVoiceProvider().info, name: 'elevenlabs', mock: false, rates } };
  const row = (over: Partial<LedgerRow>): LedgerRow => ({ id: 'l1', status: 'SUCCEEDED', provider: 'elevenlabs', model: 'eleven_v4', costBasis: 'ESTIMATED', estimatedCostUsd: 0.0016, actualCostUsd: null, usage: [{ unit: 'CHARACTERS', quantity: 20 }], response: { usageSource: 'REPORTED', attempts: 1 }, ...over });

  it('says what was sent and what the provider reported, and that nothing was reported', () => {
    expect(costText(1577, [{ name: 'character-cost', quantity: 174 }])).toBe('sent 1,577 characters; provider reported 174 (character-cost header)');
    expect(costText(184, [])).toBe('sent 184 characters; provider reported none');
    expect(costText(1, [])).toBe('sent 1 character; provider reported none');
    expect(costText(12_345_678, [{ name: 'a', quantity: 2 }, { name: 'b', quantity: 3000 }])).toBe('sent 12,345,678 characters; provider reported 2 (a header), 3,000 (b header)');
  });

  it('re-estimates a row that priced the provider’s figure (before 2026-10-06) from the characters sent, and keeps the figure raw', () => {
    // 184 characters sent, 20 reported by the header and priced: $0.0016 then, $0.01472 from what was sent.
    expect(takeCost(row({}), 184, provider)).toEqual({ ledgerId: 'l1', status: 'SUCCEEDED', basis: 'ESTIMATED', estimatedUsd: 0.01472, reportedUsd: null, characters: 184, reported: [{ name: 'character-cost', quantity: 20 }], reestimated: true, usageSource: 'REPORTED', attempts: 1 });
    // Without the characters sent, or a rate for them now, nothing can be re-estimated: the estimate is unknown, never the provider's figure priced ($0.0016), and the figure is never taken for characters.
    expect(takeCost(row({}), null, provider)).toMatchObject({ estimatedUsd: null, characters: null, reported: [{ name: 'character-cost', quantity: 20 }], reestimated: false });
    expect(takeCost(row({}), 184, { info: { ...provider.info, rates: [] } })).toMatchObject({ estimatedUsd: null, characters: 184, reported: [{ name: 'character-cost', quantity: 20 }], reestimated: false });
    // An unpriced row stays unpriced.
    expect(takeCost(row({ costBasis: 'UNPRICED', estimatedCostUsd: null }), 184, provider)).toMatchObject({ estimatedUsd: null, reestimated: false, characters: 184 });
  });

  it('reads a row written since: the characters sent were priced, the provider’s figures are beside them', () => {
    const now = row({ estimatedCostUsd: 0.01472, usage: [{ unit: 'CHARACTERS', quantity: 184 }], response: { usageSource: 'COUNTED', attempts: 1, reported: [{ name: 'character-cost', quantity: 20 }] } });
    expect(takeCost(now, 184, provider)).toMatchObject({ estimatedUsd: 0.01472, characters: 184, reported: [{ name: 'character-cost', quantity: 20 }], reestimated: false, usageSource: 'COUNTED' });
    expect(takeCost(null, 184, provider)).toBeNull();
    expect(sumReported([{ reported: [{ name: 'character-cost', quantity: 20 }] }, { reported: [] }, { reported: [{ name: 'character-cost', quantity: 154 }] }])).toEqual([{ name: 'character-cost', total: 174, requests: 2 }]);
  });
});
