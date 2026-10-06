import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  runAIContract,
  runPublishingContract,
  runRenderContract,
  runResearchContract,
  runStorageContract,
  runVideoContract,
  runVoiceContract,
} from '../contract/index.ts';
import { ProviderError } from '../types.ts';
import { MockAIProvider } from './ai.ts';
import { MOCK_FAIL_MARKER } from './common.ts';
import { MockPublishingProvider } from './publishing.ts';
import { MockRenderProvider } from './render.ts';
import { MockResearchProvider } from './research.ts';
import { MockStorageProvider } from './storage.ts';
import { MockVideoProvider } from './video.ts';
import { MOCK_WORDS_PER_MINUTE, MockVoiceProvider } from './voice.ts';
import { encodeWav, parseWav } from './wav.ts';

// Every mock must satisfy the same contracts real providers will.
runStorageContract('mock', () => new MockStorageProvider());
runVoiceContract('mock', () => new MockVoiceProvider());
runVideoContract('mock', () => new MockVideoProvider());
runAIContract('mock', () => new MockAIProvider());
runResearchContract('mock', () => new MockResearchProvider());
runRenderContract('mock', () => new MockRenderProvider(new MockStorageProvider()));
runPublishingContract('mock', () => new MockPublishingProvider());

const settings = { voiceId: 'mock-narrator-deep', model: 'mock', stability: 0.5, similarity: 0.75, style: 0, speed: 1 };

describe('mock providers are clearly labelled and never fake success', () => {
  it('labels every mock as mock', () => {
    for (const p of [new MockAIProvider(), new MockResearchProvider(), new MockVoiceProvider(), new MockVideoProvider(), new MockStorageProvider(), new MockPublishingProvider()]) {
      expect(p.info).toMatchObject({ name: 'mock', mock: true });
    }
  });

  it('answers a connectivity check as MOCK, reaching nothing', async () => {
    expect(await new MockVoiceProvider().check()).toEqual({ ok: true, detail: 'MOCK: no voice provider to reach', voiceName: '[MOCK] Deep documentary narrator', modelListed: true });
  });

  it('marks generated text as MOCK', async () => {
    const r = await new MockAIProvider().generateText({ task: 't', messages: [{ role: 'user', content: 'Write a hook' }] });
    expect(r.text).toMatch(/^\[MOCK\]/);
    expect(r.meta.mock).toBe(true);
  });

  it('refuses to invent structured output without a fixture', async () => {
    const ai = new MockAIProvider();
    await expect(
      ai.generateObject({ task: 'story.beats', schemaName: 'X', schema: z.object({ a: z.string() }), messages: [] }),
    ).rejects.toThrow(/No MOCK fixture/);
  });

  it('serves registered fixtures only if they match the schema', async () => {
    const schema = z.object({ hook: z.string() });
    const good = new MockAIProvider({ 'story.beats': { hook: 'A flower worth a house?' } });
    expect((await good.generateObject({ task: 'story.beats', schemaName: 'Beats', schema, messages: [] })).object.hook).toMatch(/flower/);
    const bad = new MockAIProvider({ 'story.beats': { hook: 42 } });
    await expect(bad.generateObject({ task: 'story.beats', schemaName: 'Beats', schema, messages: [] })).rejects.toThrow(/does not match/);
  });

  it('points mock search results at an unresolvable domain', async () => {
    const r = await new MockResearchProvider().search({ query: 'tulips' });
    for (const hit of r.results) expect(new URL(hit.url).hostname).toBe('mock.invalid');
  });

  it('never reports a mock upload as published', async () => {
    const r = await new MockPublishingProvider().uploadVideo({
      videoKey: 'k', title: 'T', description: '', tags: [], language: 'en', privacy: 'public', madeForKids: false, containsSyntheticMedia: true,
    });
    expect(r).toMatchObject({ published: false, state: 'NOT_PUBLISHED', platformVideoId: null, url: null });
  });

  it('writes a MOCK manifest instead of a video when rendering', async () => {
    const storage = new MockStorageProvider();
    const render = new MockRenderProvider(storage);
    const t = await render.renderTimeline({ projectId: 'p', language: 'en', timeline: {}, output: { width: 1920, height: 1080, fps: 30, container: 'mp4' }, outputKey: 'projects/p/en/render/final.mp4' });
    const status = await render.getRenderStatus(t.renderId);
    expect(status.outputKey).toBe('projects/p/en/render/final.mp4.mock.json');
    const manifest = JSON.parse(new TextDecoder().decode(await storage.get(status.outputKey!)));
    expect(manifest).toMatchObject({ label: 'MOCK', note: 'No media was rendered.' });
  });
});

describe('mock voice timing', () => {
  it('derives duration from word count and speed (plus a short tail of silence), measured from the WAV it returns', async () => {
    const voice = new MockVoiceProvider();
    const text = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
    expect((await voice.generateNarration({ text, language: 'en', settings })).durationMs).toBe(60_200);
    expect((await voice.generateNarration({ text, language: 'en', settings: { ...settings, speed: 1.2 } })).durationMs).toBe(50_200);
    expect(MOCK_WORDS_PER_MINUTE).toBe(150);
  });

  it('returns character timestamps shaped like a tag-aware provider: words evenly spaced, markup taking no time, pauses leaving silence', async () => {
    const r = await new MockVoiceProvider().generateNarration({ text: '[curious] one two [pause] three four', language: 'en', settings, withTimestamps: true });
    expect(r.alignment).toEqual([
      { word: 'one', startMs: 0, endMs: 400 },
      { word: 'two', startMs: 400, endMs: 800 },
      { word: 'three', startMs: 1300, endMs: 1700 },
      { word: 'four', startMs: 1700, endMs: 2100 },
    ]);
    expect(r.characters!.chars.join('')).toBe('[curious] one two [pause] three four');
    expect(r.durationMs).toBe(2300);
  });
});

describe('simulated failures (for retry testing)', () => {
  it(`fails any request containing ${MOCK_FAIL_MARKER}`, async () => {
    await expect(new MockVoiceProvider().generateNarration({ text: `x ${MOCK_FAIL_MARKER}`, language: 'en', settings })).rejects.toBeInstanceOf(ProviderError);
    await expect(new MockAIProvider().generateText({ task: 't', messages: [{ role: 'user', content: MOCK_FAIL_MARKER }] })).rejects.toMatchObject({ retryable: true });
    const video = new MockVideoProvider();
    const t = await video.createImage({ prompt: `tulip ${MOCK_FAIL_MARKER}`, aspectRatio: '16:9' });
    await video.getGenerationStatus(t.providerJobId);
    expect((await video.getGenerationStatus(t.providerJobId)).state).toBe('FAILED');
    await expect(video.downloadAsset(t.providerJobId)).rejects.toThrow(/failed/);
  });
});

describe('WAV codec', () => {
  it('round-trips header fields', () => {
    const info = parseWav(encodeWav(new Int16Array(44_100), 22_050));
    expect(info).toEqual({ sampleRate: 22_050, channels: 1, bitDepth: 16, dataBytes: 88_200, durationMs: 2000 });
  });

  it('rejects non-WAV data', () => {
    expect(() => parseWav(new TextEncoder().encode('definitely not audio'))).toThrow(/RIFF/);
  });
});
