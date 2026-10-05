import type { ProviderKind, ProviderStatusView } from '@docengine/core';
import type { AIProvider } from './ai.ts';
import { AnthropicAIProvider } from './anthropic/anthropic.ts';
import { ElevenLabsVoiceProvider } from './elevenlabs/elevenlabs.ts';
import { MockAIProvider } from './mock/ai.ts';
import { MockPublishingProvider } from './mock/publishing.ts';
import { MockRenderProvider } from './mock/render.ts';
import { MockResearchProvider } from './mock/research.ts';
import { MockStorageProvider } from './mock/storage.ts';
import { MockVideoProvider } from './mock/video.ts';
import { MockVoiceProvider } from './mock/voice.ts';
import { S3StorageProvider } from './s3/s3.ts';
import { TavilyResearchProvider } from './tavily/tavily.ts';
import type { PublishingProvider } from './publishing.ts';
import type { RenderProvider } from './render.ts';
import type { ResearchProvider } from './research.ts';
import type { StorageProvider } from './storage.ts';
import type { ProviderSettings } from './types.ts';
import type { VideoProvider } from './video.ts';
import type { VoiceProvider } from './voice.ts';

export interface ProviderSet {
  ai: AIProvider;
  research: ResearchProvider;
  voice: VoiceProvider;
  video: VideoProvider;
  storage: StorageProvider;
  render: RenderProvider;
  publishing: PublishingProvider;
}

export type ProviderSlot = keyof ProviderSet;
export type ProviderSelection = Record<ProviderSlot, string>;

export interface BaseContext {
  /** Validated provider configuration, including credentials. Never sent to the browser. */
  settings: ProviderSettings;
  /** Structured-output fixtures for the MOCK LLM, keyed by task. */
  aiFixtures: Record<string, unknown>;
}

export interface FactoryContext extends BaseContext {
  /** Already-constructed storage (render providers write their output to it). */
  storage: StorageProvider;
}

type OtherSlot = Exclude<ProviderSlot, 'storage'>;

/**
 * Implementation tables. Adding a vendor = adding one entry here (plus its
 * class). Nothing else in the application references vendor classes.
 * Storage is built first because other providers may depend on it.
 */
const STORAGE_FACTORIES: Record<string, (ctx: BaseContext) => StorageProvider> = {
  mock: () => new MockStorageProvider(),
  s3: ({ settings }) => {
    const s3 = settings.s3;
    if (!s3?.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
      throw new ProviderConfigError('STORAGE_PROVIDER=s3 needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (a Railway bucket provides them as variable references)');
    }
    return new S3StorageProvider({ endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, forcePathStyle: s3.forcePathStyle, signedUrlTtlSec: s3.signedUrlTtlSec });
  },
};

const FACTORIES: { [S in OtherSlot]: Record<string, (ctx: FactoryContext) => ProviderSet[S]> } = {
  ai: {
    mock: (ctx) => new MockAIProvider(ctx.aiFixtures),
    anthropic: ({ settings }) => {
      if (!settings.anthropic) throw new ProviderConfigError('AI_PROVIDER=anthropic needs Anthropic settings (ANTHROPIC_API_KEY, AI_MODEL)');
      return new AnthropicAIProvider(settings.anthropic);
    },
  },
  research: {
    mock: () => new MockResearchProvider(),
    tavily: ({ settings }) => {
      if (!settings.tavily) throw new ProviderConfigError('RESEARCH_PROVIDER=tavily needs Tavily settings (TAVILY_API_KEY or TAVILY_ACCESS_MODE=keyless)');
      return new TavilyResearchProvider(settings.tavily);
    },
  },
  voice: {
    mock: () => new MockVoiceProvider(),
    elevenlabs: ({ settings }) => {
      const e = settings.elevenlabs;
      if (!e?.apiKey) throw new ProviderConfigError('VOICE_PROVIDER=elevenlabs needs ELEVENLABS_API_KEY');
      return new ElevenLabsVoiceProvider({ apiKey: e.apiKey, model: e.model, voiceId: e.voiceId ?? null, outputFormat: e.outputFormat, ...(e.usdPer1kChars !== undefined ? { usdPer1kChars: e.usdPer1kChars } : {}) });
    },
  },
  video: { mock: () => new MockVideoProvider() },
  render: { mock: (ctx) => new MockRenderProvider(ctx.storage) },
  publishing: { mock: () => new MockPublishingProvider() },
};

/** Known future implementations, so configuring one gives a clear message instead of "unknown". */
export const PLANNED_PROVIDERS: Record<ProviderSlot, readonly string[]> = {
  ai: [],
  research: ['exa', 'anthropic-web-search'],
  voice: [],
  video: ['higgsfield'],
  storage: [],
  render: ['ffmpeg'],
  publishing: ['youtube'],
};

export const SLOT_KINDS: Record<ProviderSlot, ProviderKind> = {
  ai: 'AI',
  research: 'RESEARCH',
  voice: 'VOICE',
  video: 'VIDEO',
  storage: 'STORAGE',
  render: 'RENDER',
  publishing: 'PUBLISHING',
};

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

function pick<F>(slot: ProviderSlot, table: Record<string, F>, name: string): F {
  const factory = table[name];
  if (factory) return factory;
  const envVar = `${slot.toUpperCase()}_PROVIDER`;
  const available = Object.keys(table).join(', ');
  if (PLANNED_PROVIDERS[slot].includes(name)) {
    throw new ProviderConfigError(`${envVar}="${name}" is planned but not implemented yet. Available: ${available}.`);
  }
  throw new ProviderConfigError(`${envVar}="${name}" is not a known provider. Available: ${available}.`);
}

export function createProviders(
  selection: ProviderSelection,
  opts: { settings?: ProviderSettings; aiFixtures?: BaseContext['aiFixtures'] } = {},
): ProviderSet {
  const base: BaseContext = { settings: opts.settings ?? {}, aiFixtures: opts.aiFixtures ?? {} };
  const storage = pick('storage', STORAGE_FACTORIES, selection.storage)(base);
  const ctx: FactoryContext = { ...base, storage };
  const build = <S extends OtherSlot>(slot: S): ProviderSet[S] => pick(slot, FACTORIES[slot], selection[slot])(ctx);
  return {
    storage,
    ai: build('ai'),
    research: build('research'),
    voice: build('voice'),
    video: build('video'),
    render: build('render'),
    publishing: build('publishing'),
  };
}

export function describeProviders(set: ProviderSet): ProviderStatusView[] {
  return (Object.keys(SLOT_KINDS) as ProviderSlot[]).map((slot) => ({
    kind: SLOT_KINDS[slot],
    name: set[slot].info.name,
    mock: set[slot].info.mock,
  }));
}

export const ALL_MOCK: ProviderSelection = {
  ai: 'mock',
  research: 'mock',
  voice: 'mock',
  video: 'mock',
  storage: 'mock',
  render: 'mock',
  publishing: 'mock',
};
