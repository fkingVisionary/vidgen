import type { ProviderKind, ProviderStatusView } from '@docengine/core';
import type { AIProvider } from './ai.ts';
import { MockAIProvider } from './mock/ai.ts';
import { MockPublishingProvider } from './mock/publishing.ts';
import { MockRenderProvider } from './mock/render.ts';
import { MockResearchProvider } from './mock/research.ts';
import { MockStorageProvider } from './mock/storage.ts';
import { MockVideoProvider } from './mock/video.ts';
import { MockVoiceProvider } from './mock/voice.ts';
import type { PublishingProvider } from './publishing.ts';
import type { RenderProvider } from './render.ts';
import type { ResearchProvider } from './research.ts';
import type { StorageProvider } from './storage.ts';
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
  /** Server-side environment, for credentials. Never sent to the browser. */
  env: Readonly<Record<string, string | undefined>>;
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
};

const FACTORIES: { [S in OtherSlot]: Record<string, (ctx: FactoryContext) => ProviderSet[S]> } = {
  ai: { mock: (ctx) => new MockAIProvider(ctx.aiFixtures) },
  research: { mock: () => new MockResearchProvider() },
  voice: { mock: () => new MockVoiceProvider() },
  video: { mock: () => new MockVideoProvider() },
  render: { mock: (ctx) => new MockRenderProvider(ctx.storage) },
  publishing: { mock: () => new MockPublishingProvider() },
};

/** Known future implementations, so configuring one gives a clear message instead of "unknown". */
export const PLANNED_PROVIDERS: Record<ProviderSlot, readonly string[]> = {
  ai: ['anthropic'],
  research: ['anthropic-web-search', 'exa', 'tavily'],
  voice: ['elevenlabs'],
  video: ['higgsfield'],
  storage: ['s3'],
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
  opts: { env?: BaseContext['env']; aiFixtures?: BaseContext['aiFixtures'] } = {},
): ProviderSet {
  const base: BaseContext = { env: opts.env ?? {}, aiFixtures: opts.aiFixtures ?? {} };
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
