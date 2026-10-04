import { describe, expect, it } from 'vitest';
import { ALL_MOCK, ProviderConfigError, createProviders, describeProviders } from './registry.ts';
import { buildAssetKey } from './storage.ts';

describe('createProviders', () => {
  it('builds a complete all-mock provider set without credentials', () => {
    const set = createProviders(ALL_MOCK);
    expect(describeProviders(set)).toEqual([
      { kind: 'AI', name: 'mock', mock: true },
      { kind: 'RESEARCH', name: 'mock', mock: true },
      { kind: 'VOICE', name: 'mock', mock: true },
      { kind: 'VIDEO', name: 'mock', mock: true },
      { kind: 'STORAGE', name: 'mock', mock: true },
      { kind: 'RENDER', name: 'mock', mock: true },
      { kind: 'PUBLISHING', name: 'mock', mock: true },
    ]);
  });

  it('explains that a planned provider is not implemented yet', () => {
    expect(() => createProviders({ ...ALL_MOCK, voice: 'elevenlabs' })).toThrow(ProviderConfigError);
    expect(() => createProviders({ ...ALL_MOCK, voice: 'elevenlabs' })).toThrow(/VOICE_PROVIDER="elevenlabs" is planned but not implemented yet/);
  });

  it('rejects unknown providers', () => {
    expect(() => createProviders({ ...ALL_MOCK, video: 'sora-ish' })).toThrow(/not a known provider/);
  });
});

describe('buildAssetKey', () => {
  it('separates per-language and shared assets', () => {
    expect(buildAssetKey({ projectId: 'p1', language: 'es', kind: 'NARRATION_AUDIO', assetId: 'a1', ext: 'wav' })).toBe('projects/p1/es/narration_audio/a1.wav');
    expect(buildAssetKey({ projectId: 'p1', kind: 'VIDEO_CLIP', assetId: 'a2', ext: '.mp4' })).toBe('projects/p1/shared/video_clip/a2.mp4');
  });

  it('refuses ids that would escape the project prefix', () => {
    expect(() => buildAssetKey({ projectId: '..', kind: 'IMAGE', assetId: 'x', ext: 'png' })).toThrow(/Invalid storage key/);
  });
});
