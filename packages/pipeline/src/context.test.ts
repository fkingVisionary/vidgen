import type { Database, Job, LanguageVersion, Project } from '@docengine/database';
import { ElevenLabsVoiceProvider, ProviderError, type ProviderSet } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import { createStageContext, priceCall } from './context.ts';
import { silentLogger } from './logger.ts';

/**
 * The provider_calls ledger as callProvider writes it, against the real
 * ElevenLabs provider on a fake endpoint and a ledger that only records
 * (no database, no network, no key).
 */

/** Two MPEG-1 layer III frames (128 kbps, 44.1 kHz). */
const MP3 = (() => {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0xc4]);
  const out = new Uint8Array(834);
  out.set(frame, 0);
  out.set(frame, 417);
  return Buffer.from(out).toString('base64');
})();

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function setup(responses: Response[]) {
  const rows: Record<string, unknown>[] = [];
  const db = {
    providerCall: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rows.push({ ...data });
        return { id: `call-${rows.length}` };
      },
      update: async ({ data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.at(-1)!, data),
    },
  } as unknown as Database;
  const voice = new ElevenLabsVoiceProvider({ apiKey: 'test-key', model: 'eleven_v4', outputFormat: 'mp3_44100_128', fetch: async () => responses.shift()!, sleep: async () => undefined });
  const ctx = createStageContext({
    job: { id: 'job-1', projectId: 'project-1', languageVersionId: 'lv-1' } as Job,
    project: { id: 'project-1' } as Project,
    languageVersion: { id: 'lv-1' } as LanguageVersion,
    db,
    providers: { voice } as unknown as ProviderSet,
    logger: silentLogger,
    signal: new AbortController().signal,
  });
  const narrate = (summarize: (r: { durationMs: number }) => unknown = (r) => ({ durationMs: r.durationMs })) =>
    ctx.callProvider('voice', 'generateNarration', () => voice.generateNarration({ text: 'Short line.', language: 'en', settings: { voiceId: 'voice-abc', model: 'eleven_v4', stability: 0.5, similarity: 0.75, style: 0, speed: 1 }, withTimestamps: true }), { summarize });
  return { rows, narrate };
}

describe('the provider_calls ledger', () => {
  it('records the attempts a call took and whether its usage was reported or counted', async () => {
    const { rows, narrate } = setup([
      json(429, { detail: { code: 'concurrent_limit_exceeded', message: 'busy' } }),
      json(200, { audio_base64: MP3, alignment: null }, { 'character-cost': '11', 'request-id': 'req-1', 'history-item-id': 'hist-1' }),
    ]);
    await narrate();
    expect(rows[0]).toMatchObject({
      status: 'SUCCEEDED',
      providerRequestId: 'req-1',
      providerJobId: 'hist-1',
      usage: [{ unit: 'CHARACTERS', quantity: 11 }],
      response: { durationMs: 52, attempts: 2, usageSource: 'REPORTED' },
      costBasis: 'ESTIMATED',
      costNote: '11 character(s) reported by ElevenLabs (character-cost)',
    });
  });

  it('costs a failure after a 2xx (the characters may have been billed) as an ESTIMATE, not as nothing', async () => {
    const { rows, narrate } = setup([json(200, { alignment: null }, { 'request-id': 'req-2' })]);
    await expect(narrate()).rejects.toThrow(/Response had no audio/);
    expect(rows[0]).toMatchObject({
      status: 'FAILED',
      error: '[elevenlabs] Response had no audio',
      providerRequestId: 'req-2',
      usage: [{ unit: 'CHARACTERS', quantity: 11 }],
      response: { attempts: 1, usageSource: 'COUNTED' },
      costBasis: 'ESTIMATED',
      estimatedCostUsd: 0.00088,
      costNote: 'Response unusable; characters may have been billed. ElevenLabs reported no character cost: 11 character(s) counted as sent',
    });
  });

  it('records the attempts of a failure that was never served, and costs nothing for it', async () => {
    const down = () => json(503, { detail: { code: 'service_unavailable', message: 'down' } });
    const { rows, narrate } = setup([down(), down(), down()]);
    await expect(narrate()).rejects.toBeInstanceOf(ProviderError);
    expect(rows[0]).toMatchObject({ status: 'FAILED', response: { attempts: 3 } });
    expect(rows[0]).not.toHaveProperty('costBasis');
    expect(rows[0]).not.toHaveProperty('usage');
  });

  it('keeps a summary that is not an object next to the call facts', async () => {
    const { rows, narrate } = setup([json(200, { audio_base64: MP3, alignment: null })]);
    await narrate((r) => [r.durationMs]);
    expect(rows[0]!.response).toEqual({ summary: [52], attempts: 1, usageSource: 'COUNTED' });
  });

  it('prices characters counted as sent as an ESTIMATE, like reported ones', () => {
    expect(priceCall({ provider: 'elevenlabs', model: 'eleven_v4', mock: false, usage: [{ unit: 'CHARACTERS', quantity: 1000 }], usageSource: 'COUNTED', attempts: 1 }, [{ provider: 'elevenlabs', model: 'eleven_v4', unit: 'CHARACTERS', usdPerUnit: 0.00008 }])).toMatchObject({ costBasis: 'ESTIMATED', estimatedCostUsd: 0.08 });
  });
});
