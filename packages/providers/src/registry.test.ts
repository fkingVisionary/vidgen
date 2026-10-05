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
    expect(() => createProviders({ ...ALL_MOCK, video: 'higgsfield' })).toThrow(ProviderConfigError);
    expect(() => createProviders({ ...ALL_MOCK, video: 'higgsfield' })).toThrow(/VIDEO_PROVIDER="higgsfield" is planned but not implemented yet/);
  });

  it('builds ElevenLabs voice and S3 storage from settings, and says which settings are missing', () => {
    expect(() => createProviders({ ...ALL_MOCK, voice: 'elevenlabs' })).toThrow(/VOICE_PROVIDER=elevenlabs needs ELEVENLABS_API_KEY/);
    expect(() => createProviders({ ...ALL_MOCK, storage: 's3' }, { settings: { s3: { region: 'auto', forcePathStyle: false, signedUrlTtlSec: 3600 } } })).toThrow(/S3_ENDPOINT, S3_BUCKET/);
    const set = createProviders(
      { ...ALL_MOCK, voice: 'elevenlabs', storage: 's3' },
      {
        settings: {
          elevenlabs: { apiKey: 'test-key', model: 'eleven_v4', outputFormat: 'mp3_44100_128' },
          s3: { endpoint: 'https://t3.storageapi.dev', region: 'auto', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', forcePathStyle: false, signedUrlTtlSec: 3600 },
        },
      },
    );
    expect(describeProviders(set).filter((p) => !p.mock)).toEqual([
      { kind: 'VOICE', name: 'elevenlabs', mock: false },
      { kind: 'STORAGE', name: 's3', mock: false },
    ]);
    expect(set.voice.defaults).toEqual({ model: 'eleven_v4', voiceId: null, outputFormat: 'mp3_44100_128' });
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
