import { describe, expect, it } from 'vitest';
import { ApprovalInput, CreateProjectInput, EnqueueJobInput } from './api.ts';
import { QaFindings, VoiceSettings } from './creative.ts';
import { InfographicSpec } from './infographic.ts';

const source = { citation: 'Goldgar, A. (2007). Tulipmania. University of Chicago Press.' };

describe('InfographicSpec', () => {
  it('accepts a price chart with approximate values and a source', () => {
    const spec = InfographicSpec.parse({
      chartType: 'PRICE_CHANGE',
      title: 'Illustrative bulb price index',
      currency: 'guilders',
      durationSec: 8,
      source,
      series: [
        {
          name: 'Example contract prices',
          points: [
            { label: 'Dec 1636', value: 100, approximate: true },
            { label: 'Feb 1637', value: 400, approximate: true },
          ],
        },
      ],
    });
    expect(spec.chartType).toBe('PRICE_CHANGE');
    expect(spec.animation).toBe('REVEAL'); // default
  });

  it('rejects a chart without a source', () => {
    const r = InfographicSpec.safeParse({
      chartType: 'NUMBER_COUNTER',
      title: 'Guilders',
      durationSec: 4,
      value: 5000,
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    const r = InfographicSpec.safeParse({
      chartType: 'NUMBER_COUNTER',
      title: 'Broken',
      durationSec: 4,
      source,
      value: Number.POSITIVE_INFINITY,
    });
    expect(r.success).toBe(false);
  });

  it('rejects map routes that reference unknown locations', () => {
    const r = InfographicSpec.safeParse({
      chartType: 'MAP',
      title: 'Bulb trade',
      durationSec: 6,
      source,
      region: 'Dutch Republic',
      locations: [{ name: 'Haarlem', lat: 52.38, lon: 4.64 }],
      routes: [{ from: 'Haarlem', to: 'Amsterdam' }],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/Unknown location "Amsterdam"/);
  });

  it('rejects flow diagrams whose edges reference unknown nodes', () => {
    const r = InfographicSpec.safeParse({
      chartType: 'FLOW_DIAGRAM',
      title: 'Futures contract',
      durationSec: 6,
      source,
      nodes: [
        { id: 'buyer', label: 'Buyer' },
        { id: 'seller', label: 'Seller' },
      ],
      edges: [{ from: 'buyer', to: 'notary' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown chart types', () => {
    expect(InfographicSpec.safeParse({ chartType: 'PIE_3D', title: 'x', durationSec: 3, source }).success).toBe(false);
  });
});

describe('API inputs', () => {
  it('applies project defaults and trims strings', () => {
    const p = CreateProjectInput.parse({ title: '  Tulip Mania ', topic: 'Dutch tulip bulb market, 1636–37' });
    expect(p).toMatchObject({ title: 'Tulip Mania', targetMinutesMin: 10, targetMinutesMax: 15, masterLanguage: 'en' });
  });

  it('rejects an inverted target length and unsupported languages', () => {
    expect(CreateProjectInput.safeParse({ title: 'x', topic: 'y', targetMinutesMin: 20, targetMinutesMax: 10 }).success).toBe(false);
    expect(CreateProjectInput.safeParse({ title: 'x', topic: 'y', masterLanguage: 'xx' }).success).toBe(false);
  });

  it('validates job types and approval decisions', () => {
    expect(EnqueueJobInput.safeParse({ type: 'RESEARCH' }).success).toBe(true);
    expect(EnqueueJobInput.safeParse({ type: 'MAKE_IT_GOOD' }).success).toBe(false);
    expect(ApprovalInput.safeParse({ gate: 'SCRIPT', decision: 'REGENERATE' }).success).toBe(false);
  });
});

describe('creative contracts', () => {
  it('bounds voice settings', () => {
    const base = { provider: 'elevenlabs', voiceId: 'voice-from-config', model: 'm', stability: 0.5, similarity: 0.75, style: 0, speed: 1 };
    expect(VoiceSettings.safeParse(base).success).toBe(true);
    expect(VoiceSettings.safeParse({ ...base, stability: 1.5 }).success).toBe(false);
  });

  it('bounds QA scores to 0–100', () => {
    const ok = { overallScore: 80, categoryScores: { TIMING: 90 }, warnings: [], blockingErrors: [] };
    expect(QaFindings.safeParse(ok).success).toBe(true);
    expect(QaFindings.safeParse({ ...ok, categoryScores: { TIMING: 101 } }).success).toBe(false);
  });
});
