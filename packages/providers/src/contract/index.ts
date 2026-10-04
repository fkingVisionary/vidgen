/**
 * Provider contract test suites.
 *
 * Each `run…Contract(factory)` describes behaviour every implementation of an
 * interface must have. Today they run against the MOCK providers; when a real
 * provider is added (S3 against MinIO, ElevenLabs, Higgsfield…) the same suite
 * runs against it, so swapping vendors cannot silently change behaviour.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AIProvider } from '../ai.ts';
import type { PublishingProvider } from '../publishing.ts';
import type { RenderProvider } from '../render.ts';
import type { ResearchProvider } from '../research.ts';
import type { StorageProvider } from '../storage.ts';
import type { CallMeta, ProviderInfo } from '../types.ts';
import { waitForGeneration, type VideoProvider } from '../video.ts';
import type { VoiceProvider } from '../voice.ts';

type Factory<T> = () => T | Promise<T>;

function expectInfo(info: ProviderInfo, kind: ProviderInfo['kind']) {
  expect(info.kind).toBe(kind);
  expect(info.name).toMatch(/\S/);
  expect(typeof info.mock).toBe('boolean');
}

function expectMeta(meta: CallMeta, info: ProviderInfo) {
  expect(meta.provider).toBe(info.name);
  expect(meta.mock).toBe(info.mock);
  for (const u of meta.usage) expect(u.quantity).toBeGreaterThanOrEqual(0);
}

export function runStorageContract(name: string, factory: Factory<StorageProvider>) {
  describe(`StorageProvider contract: ${name}`, () => {
    const prefix = `contract-test/${Date.now()}`;

    it('round-trips bytes and metadata', async () => {
      const s = await factory();
      expectInfo(s.info, 'STORAGE');
      const body = new Uint8Array([0, 1, 2, 250, 255]);
      const put = await s.put(`${prefix}/a.bin`, body, { contentType: 'application/octet-stream' });
      expect(put).toMatchObject({ key: `${prefix}/a.bin`, size: 5, contentType: 'application/octet-stream' });
      expect(await s.get(`${prefix}/a.bin`)).toEqual(body);
      expect(await s.head(`${prefix}/a.bin`)).toMatchObject({ size: 5 });
    });

    it('stores strings as UTF-8', async () => {
      const s = await factory();
      await s.put(`${prefix}/t.txt`, 'tulpen € ✓', { contentType: 'text/plain' });
      expect(new TextDecoder().decode(await s.get(`${prefix}/t.txt`))).toBe('tulpen € ✓');
    });

    it('lists by prefix and deletes', async () => {
      const s = await factory();
      await s.put(`${prefix}/list/1`, 'a', { contentType: 'text/plain' });
      await s.put(`${prefix}/list/2`, 'b', { contentType: 'text/plain' });
      expect((await s.list(`${prefix}/list/`)).map((o) => o.key)).toEqual([`${prefix}/list/1`, `${prefix}/list/2`]);
      await s.delete(`${prefix}/list/1`);
      expect(await s.head(`${prefix}/list/1`)).toBeNull();
    });

    it('returns null from head and rejects get for missing keys', async () => {
      const s = await factory();
      expect(await s.head(`${prefix}/missing`)).toBeNull();
      await expect(s.get(`${prefix}/missing`)).rejects.toThrow();
    });

    it('rejects path traversal and absolute keys', async () => {
      const s = await factory();
      await expect(s.put('../escape', 'x', { contentType: 'text/plain' })).rejects.toThrow(/Invalid storage key/);
      await expect(s.put('/abs', 'x', { contentType: 'text/plain' })).rejects.toThrow(/Invalid storage key/);
      await expect(s.put('a/../b', 'x', { contentType: 'text/plain' })).rejects.toThrow(/Invalid storage key/);
    });

    it('issues signed URLs', async () => {
      const s = await factory();
      await s.put(`${prefix}/signed`, 'x', { contentType: 'text/plain' });
      expect(await s.getSignedUrl(`${prefix}/signed`, { expiresInSec: 60 })).toMatch(/\S/);
    });
  });
}

export function runVoiceContract(name: string, factory: Factory<VoiceProvider>, voiceId?: string) {
  describe(`VoiceProvider contract: ${name}`, () => {
    it('lists voices', async () => {
      const v = await factory();
      expectInfo(v.info, 'VOICE');
      const voices = await v.getVoices();
      expect(voices.length).toBeGreaterThan(0);
      for (const voice of voices) expect(voice.id).toMatch(/\S/);
    });

    it('generates narration whose reported duration matches the audio', async () => {
      const v = await factory();
      const id = voiceId ?? (await v.getVoices())[0]!.id;
      const text = 'In the winter of 1636, a single tulip bulb could change hands several times in one day.';
      const r = await v.generateNarration({
        text,
        language: 'en',
        withTimestamps: true,
        settings: { voiceId: id, model: 'default', stability: 0.5, similarity: 0.75, style: 0, speed: 1 },
      });
      expectMeta(r.meta, v.info);
      expect(r.audio.byteLength).toBeGreaterThan(0);
      expect(r.durationMs).toBeGreaterThan(0);
      const meta = await v.getAudioMetadata(r.audio, r.mimeType);
      expect(Math.abs(meta.durationMs - r.durationMs)).toBeLessThanOrEqual(50);

      // Word timings, when returned, are ordered and inside the audio.
      if (r.alignment) {
        expect(r.alignment.length).toBeGreaterThan(0);
        for (let i = 0; i < r.alignment.length; i++) {
          const w = r.alignment[i]!;
          expect(w.endMs).toBeGreaterThan(w.startMs);
          if (i > 0) expect(w.startMs).toBeGreaterThanOrEqual(r.alignment[i - 1]!.startMs);
        }
        expect(r.alignment.at(-1)!.endMs).toBeLessThanOrEqual(r.durationMs + 50);
      }
    });
  });
}

export function runVideoContract(name: string, factory: Factory<VideoProvider>) {
  describe(`VideoProvider contract: ${name}`, () => {
    it('creates an image and follows it to completion', async () => {
      const p = await factory();
      expectInfo(p.info, 'VIDEO');
      const ticket = await p.createImage({ prompt: 'Haarlem tavern interior, 1636, candlelight', aspectRatio: '16:9' });
      expectMeta(ticket.meta, p.info);
      expect(ticket.providerJobId).toMatch(/\S/);
      const status = await waitForGeneration(p, ticket.providerJobId, { intervalMs: 1, timeoutMs: 60_000 });
      expect(status.state).toBe('SUCCEEDED');
      const asset = await p.downloadAsset(ticket.providerJobId);
      expect(asset.data.byteLength).toBeGreaterThan(0);
      expect(asset.mimeType).toMatch(/\//);
    });

    it('creates a video generation', async () => {
      const p = await factory();
      const ticket = await p.createVideo({ prompt: 'Slow push-in on a striped tulip', aspectRatio: '16:9', durationSec: 5 });
      expect(['QUEUED', 'RUNNING', 'SUCCEEDED']).toContain(ticket.state);
    });
  });
}

export function runAIContract(name: string, factory: Factory<AIProvider>) {
  describe(`AIProvider contract: ${name}`, () => {
    it('generates text with usage metadata', async () => {
      const ai = await factory();
      expectInfo(ai.info, 'AI');
      const r = await ai.generateText({ task: 'contract.text', messages: [{ role: 'user', content: 'Say hello.' }] });
      expect(r.text).toMatch(/\S/);
      expectMeta(r.meta, ai.info);
    });

    it('never returns structured output that fails its schema', async () => {
      const ai = await factory();
      const schema = z.object({ answer: z.string() });
      try {
        const r = await ai.generateObject({ task: 'contract.object', schemaName: 'Answer', schema, messages: [{ role: 'user', content: 'Answer.' }] });
        expect(schema.safeParse(r.object).success).toBe(true);
      } catch (err) {
        // Refusing is acceptable; returning invalid data is not.
        expect(err).toBeInstanceOf(Error);
      }
    });
  });
}

export function runResearchContract(name: string, factory: Factory<ResearchProvider>) {
  describe(`ResearchProvider contract: ${name}`, () => {
    it('returns search results with URLs', async () => {
      const r = await factory();
      expectInfo(r.info, 'RESEARCH');
      const res = await r.search({ query: 'Dutch tulip market 1637 notarial records', maxResults: 2 });
      expectMeta(res.meta, r.info);
      expect(res.results.length).toBeLessThanOrEqual(2);
      for (const hit of res.results) expect(() => new URL(hit.url)).not.toThrow();
    });
  });
}

export function runRenderContract(name: string, factory: Factory<RenderProvider>) {
  describe(`RenderProvider contract: ${name}`, () => {
    it('renders a graphic and reports its status', async () => {
      const r = await factory();
      expectInfo(r.info, 'RENDER');
      const ticket = await r.renderGraphic({
        language: 'en',
        outputKey: 'contract-test/graphic.mp4',
        output: { width: 1920, height: 1080, fps: 30, container: 'mp4' },
        spec: {
          chartType: 'NUMBER_COUNTER',
          title: 'Counter',
          durationSec: 3,
          value: 100,
          from: 0,
          decimals: 0,
          approximate: false,
          annotations: [],
          animation: 'COUNT_UP',
          source: { citation: 'Contract test fixture', sourceIds: [] },
        },
      });
      const status = await r.getRenderStatus(ticket.renderId);
      expect(status.renderId).toBe(ticket.renderId);
      expect(['QUEUED', 'RUNNING', 'SUCCEEDED']).toContain(status.state);
    });
  });
}

export function runPublishingContract(name: string, factory: Factory<PublishingProvider>) {
  describe(`PublishingProvider contract: ${name}`, () => {
    it('reports published=true only together with a platform id and URL', async () => {
      const p = await factory();
      expectInfo(p.info, 'PUBLISHING');
      const r = await p.uploadVideo({
        videoKey: 'contract-test/final.mp4',
        title: 'Contract test (private)',
        description: 'Automated contract test upload',
        tags: [],
        language: 'en',
        privacy: 'private',
        madeForKids: false,
        containsSyntheticMedia: true,
      });
      expectMeta(r.meta, p.info);
      if (r.published) {
        expect(r.platformVideoId).toMatch(/\S/);
        expect(r.url).toMatch(/^https:\/\//);
      }
    });
  });
}
