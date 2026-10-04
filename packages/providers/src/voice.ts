import type { VoiceSettings } from '@docengine/core';
import type { CallMeta, ProviderInfo } from './types.ts';

export interface Voice {
  id: string;
  name: string;
  language?: string;
  description?: string;
  previewUrl?: string;
}

/** VoiceSettings without the provider name (the provider is implied by who receives it). */
export type NarrationSettings = Omit<VoiceSettings, 'provider'>;

export interface NarrationRequest {
  /** One scene or paragraph of narration. Long scripts are generated in chunks. */
  text: string;
  language: string;
  settings: NarrationSettings;
  /** Return word-level timestamps (drives subtitles and edit timing). */
  withTimestamps?: boolean;
  /** Neighbouring text so prosody stays continuous across chunks. */
  previousText?: string;
  nextText?: string;
}

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface NarrationResult {
  audio: Uint8Array;
  mimeType: string;
  durationMs: number;
  alignment: WordTiming[] | null;
  meta: CallMeta;
}

export interface AudioMetadata {
  durationMs: number;
  sampleRate: number;
  channels: number;
  format: string;
  bitDepth?: number;
}

/** Text-to-speech narration. Planned implementation: ElevenLabs. */
export interface VoiceProvider {
  readonly info: ProviderInfo;
  getVoices(): Promise<Voice[]>;
  generateNarration(req: NarrationRequest): Promise<NarrationResult>;
  getAudioMetadata(audio: Uint8Array, mimeType: string): Promise<AudioMetadata>;
}
