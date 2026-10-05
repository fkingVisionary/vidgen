import { randomUUID } from 'node:crypto';
import { InfographicSpec, type JobType } from '@docengine/core';
import { MOCK_LABEL, buildAssetKey, waitForGeneration } from '@docengine/providers';
import type { StageContext } from '../context.ts';
import type { StageHandler, StageHandlers } from '../handlers.ts';

/**
 * PLACEHOLDER stage handlers for milestone 1.
 *
 * They exist to prove the plumbing — job queue → handler → provider
 * interface → cost ledger → status machine — without API credits. They do
 * NOT do the stage's real work: no research claims, story candidates, story
 * architecture, script, storyboard or timeline rows are created, and every
 * result says so. Each is replaced by a real module (modules/<stage>) once
 * that stage is built.
 */

const NOT_DONE: Record<JobType, string> = {
  RESEARCH: 'No research was performed. No sources or claims were created.',
  STORY_MINING: 'No story mining was performed. No story candidates were created.',
  STORY_ARCHITECTURE: 'No story architecture was written.',
  STORY_ANGLES: 'No narrative angles were explored.',
  SCRIPT: 'No script was written.',
  VOICE: 'No speech was synthesised (mock audio is a beep followed by silence).',
  VISUAL_PLAN: 'No storyboard was created.',
  VISUAL_GENERATION: 'No imagery was generated (mock output is a labelled placeholder).',
  INFOGRAPHIC: 'No infographic was rendered.',
  EDIT: 'No timeline was assembled.',
  RENDER: 'No video was rendered (mock output is a JSON manifest).',
  QA: 'No QA was performed. No scores were produced.',
  PUBLISH: 'Nothing was uploaded or published.',
};

const mockResult = (type: JobType, details: Record<string, unknown> = {}) => ({
  mock: true,
  label: MOCK_LABEL,
  note: NOT_DONE[type],
  ...details,
});

/** Mock generations finish within a couple of polls; real ones need a slower cadence. */
const pollInterval = (ctx: StageContext) => (ctx.providers.video.info.mock ? 5 : 5_000);

function textStage(type: JobType, task: string): StageHandler {
  return {
    type,
    mock: true,
    async run(ctx) {
      const r = await ctx.callProvider('ai', 'generateText', () =>
        ctx.providers.ai.generateText({
          task,
          messages: [{ role: 'user', content: `Topic: ${ctx.project.topic}` }],
        }),
        { request: { task } },
      );
      return mockResult(type, { output: r.text });
    },
  };
}

const handlers: StageHandler[] = [
  {
    type: 'RESEARCH',
    mock: true,
    async run(ctx) {
      const r = await ctx.callProvider('research', 'search', () => ctx.providers.research.search({ query: ctx.project.topic, maxResults: 3 }), {
        request: { query: ctx.project.topic },
        summarize: (res) => ({ results: res.results.length }),
      });
      return mockResult('RESEARCH', { searchResults: r.results.length });
    },
  },
  textStage('STORY_MINING', 'story.mine'),
  textStage('STORY_ARCHITECTURE', 'story.architecture'),
  textStage('STORY_ANGLES', 'story.angles'),
  textStage('SCRIPT', 'script.draft'),
  {
    type: 'VOICE',
    mock: true,
    async run(ctx) {
      const { voice, storage } = ctx.providers;
      const [firstVoice] = await voice.getVoices();
      if (!firstVoice) throw new Error('Voice provider returned no voices');
      const text = `${MOCK_LABEL} narration sample for ${ctx.project.title}.`;
      const r = await ctx.callProvider('voice', 'generateNarration', () =>
        voice.generateNarration({
          text,
          language: ctx.languageVersion.language,
          withTimestamps: true,
          settings: { voiceId: firstVoice.id, model: 'mock', stability: 0.5, similarity: 0.75, style: 0, speed: 1 },
        }),
        { request: { characters: text.length, voiceId: firstVoice.id } },
      );
      const key = buildAssetKey({ projectId: ctx.project.id, language: ctx.languageVersion.language, kind: 'NARRATION_AUDIO', assetId: randomUUID(), ext: 'wav' });
      await storage.put(key, r.audio, { contentType: r.mimeType });
      return mockResult('VOICE', { storageKey: key, durationMs: r.durationMs, words: r.alignment?.length ?? 0 });
    },
  },
  textStage('VISUAL_PLAN', 'visual.storyboard'),
  {
    type: 'VISUAL_GENERATION',
    mock: true,
    async run(ctx) {
      const { video, storage } = ctx.providers;
      const prompt = `${MOCK_LABEL} establishing shot for "${ctx.project.title}"`;
      const ticket = await ctx.callProvider('video', 'createImage', () => video.createImage({ prompt, aspectRatio: '16:9' }), {
        request: { prompt, aspectRatio: '16:9' },
      });
      const status = await waitForGeneration(video, ticket.providerJobId, { intervalMs: pollInterval(ctx), signal: ctx.signal });
      if (status.state === 'FAILED') throw new Error(`Generation ${ticket.providerJobId} failed: ${status.error ?? 'unknown'}`);
      const asset = await video.downloadAsset(ticket.providerJobId);
      const key = buildAssetKey({ projectId: ctx.project.id, kind: 'IMAGE', assetId: randomUUID(), ext: 'svg' });
      await storage.put(key, asset.data, { contentType: asset.mimeType });
      return mockResult('VISUAL_GENERATION', { providerJobId: ticket.providerJobId, storageKey: key, placeholder: asset.placeholder });
    },
  },
  {
    type: 'INFOGRAPHIC',
    mock: true,
    async run(ctx) {
      const spec = InfographicSpec.parse({
        chartType: 'NUMBER_COUNTER',
        title: `${MOCK_LABEL} counter`,
        durationSec: 3,
        value: 0,
        source: { citation: `${MOCK_LABEL} — no data. Placeholder spec for pipeline testing.` },
      });
      const key = buildAssetKey({ projectId: ctx.project.id, language: ctx.languageVersion.language, kind: 'INFOGRAPHIC', assetId: randomUUID(), ext: 'mp4' });
      const t = await ctx.callProvider('render', 'renderGraphic', () =>
        ctx.providers.render.renderGraphic({ spec, language: ctx.languageVersion.language, output: { width: 1920, height: 1080, fps: 30, container: 'mp4' }, outputKey: key }),
      );
      const status = await ctx.providers.render.getRenderStatus(t.renderId);
      return mockResult('INFOGRAPHIC', { renderId: t.renderId, outputKey: status.outputKey ?? null });
    },
  },
  { type: 'EDIT', mock: true, run: async () => mockResult('EDIT') },
  {
    type: 'RENDER',
    mock: true,
    async run(ctx) {
      const key = buildAssetKey({ projectId: ctx.project.id, language: ctx.languageVersion.language, kind: 'RENDER', assetId: randomUUID(), ext: 'mp4' });
      const t = await ctx.callProvider('render', 'renderTimeline', () =>
        ctx.providers.render.renderTimeline({
          projectId: ctx.project.id,
          language: ctx.languageVersion.language,
          timeline: {},
          output: { width: 1920, height: 1080, fps: 30, container: 'mp4', loudnessLufs: -14 },
          outputKey: key,
        }),
      );
      const status = await ctx.providers.render.getRenderStatus(t.renderId);
      return mockResult('RENDER', { renderId: t.renderId, outputKey: status.outputKey ?? null });
    },
  },
  { type: 'QA', mock: true, run: async () => mockResult('QA', { overallScore: null }) },
  {
    type: 'PUBLISH',
    mock: true,
    async run(ctx) {
      const r = await ctx.callProvider('publishing', 'uploadVideo', () =>
        ctx.providers.publishing.uploadVideo({
          videoKey: 'none',
          title: ctx.project.title,
          description: '',
          tags: [],
          language: ctx.languageVersion.language,
          privacy: 'private',
          madeForKids: false,
          containsSyntheticMedia: true,
        }),
      );
      return mockResult('PUBLISH', { published: r.published, state: r.state });
    },
  },
];

export function createMockStageHandlers(): StageHandlers {
  return Object.fromEntries(handlers.map((h) => [h.type, h])) as StageHandlers;
}
