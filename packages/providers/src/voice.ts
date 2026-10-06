import type { EmphasisLevel, PauseLength, PerformanceIntent, ProviderSettingValues, VoiceSettingDescriptor } from '@docengine/core';
import type { CallMeta, ProviderInfo } from './types.ts';

export interface Voice {
  id: string;
  name: string;
  language?: string;
  description?: string;
  previewUrl?: string;
}

/** What a voice is asked with: the voice, the model and the provider's settings (the provider is implied by who receives it). */
export interface NarrationSettings {
  voiceId: string;
  model: string;
  /** Provider settings as `normalizeSettings` returns them (the provider sends what the model takes). */
  provider?: ProviderSettingValues;
  /** Shorthand from before provider settings (the mock stage, the script's render plan); read only when `provider` is absent. */
  stability?: number;
  similarity?: number;
  style?: number;
  speed?: number;
  speakerBoost?: boolean;
}

/** A pronunciation rule a provider applies itself (phonemes; aliases are spoken text already). */
export interface PronunciationRule {
  term: string;
  method: 'IPA' | 'CMU';
  pronunciation: string;
}

export interface NarrationRequest {
  /**
   * One small chunk of narration, exactly as it is to be spoken — spoken
   * forms and the provider's own performance markup included (see `render`).
   * A script is never sent whole: it is generated chunk by chunk.
   */
  text: string;
  language: string;
  settings: NarrationSettings;
  /** Return timestamps (drive the narration timeline, subtitles and the edit). */
  withTimestamps?: boolean;
  /** Neighbouring narration, heard as context so prosody stays continuous across chunks (not generated). */
  previousText?: string;
  nextText?: string;
  /** Earlier takes' request ids as context (request stitching), when the model supports it. */
  previousRequestIds?: string[];
  /** Provider-specific output format ("mp3_44100_128"); the provider's default when omitted. */
  outputFormat?: string;
  /** Best-effort deterministic sampling. */
  seed?: number;
  pronunciations?: PronunciationRule[];
  /** Cancels the request (the job was cancelled). */
  signal?: AbortSignal;
}

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

/** The provider's timestamps for each character of the text it received. */
export interface CharacterAlignment {
  chars: string[];
  startMs: number[];
  endMs: number[];
}

export interface NarrationResult {
  audio: Uint8Array;
  mimeType: string;
  /** Measured from the audio itself (not estimated). */
  durationMs: number;
  /** Word timings derived from the provider's timestamps (null when it returned none). */
  alignment: WordTiming[] | null;
  /** The provider's character timestamps for the text it received (null when it returned none). */
  characters: CharacterAlignment | null;
  /** The vendor's id for this request (support, request stitching). */
  requestId?: string;
  /** The provider's pronunciation dictionary used, if any (for the record). */
  dictionary?: { id: string; version: string } | null;
  meta: CallMeta;
}

export interface AudioMetadata {
  durationMs: number;
  sampleRate: number;
  channels: number;
  format: string;
  bitDepth?: number;
}

/** What a model can express, so nothing is sent that it would read aloud or reject. */
export interface VoiceModelCapabilities {
  model: string;
  /** Natural-language performance directions in the text (audio tags). */
  directions: boolean;
  /** How a pause inside one request is written: audio tags, SSML breaks, or line breaks and punctuation only. */
  pauses: 'TAGS' | 'BREAKS' | 'PUNCTUATION';
  /** Phoneme rules (IPA/CMU) in a pronunciation dictionary. */
  phonemes: boolean;
  /** Neighbouring text as context. */
  contextText: boolean;
  /** Earlier takes' request ids as context. */
  stitching: boolean;
  languageCode: boolean;
  maxCharacters: number;
  /** False for a model the provider does not know: it gets plain text and conservative settings. */
  known: boolean;
}

/** One sentence of a chunk, spoken form, with the direction before it and the pause after it. */
export interface PerformanceSegment {
  text: string;
  intent: PerformanceIntent | null;
  pauseAfter: PauseLength;
  /** Stressed words, as character ranges in `text`; a model that cannot stress a word without changing it reports them unsupported. */
  emphasis?: { start: number; end: number; level: EmphasisLevel }[];
}

/** A chunk rendered in a provider's markup. Pure: nothing is sent. */
export interface RenderedNarration {
  /** The exact text to send. */
  text: string;
  /** Where each segment's text is in `text` (verbatim, same length). */
  segments: { start: number; end: number }[];
  /** Markup the provider added, by range. */
  markup: { start: number; end: number; kind: 'DIRECTION' | 'PAUSE' }[];
  /** Directions or pauses the model cannot express (kept in the record, not sent). */
  unsupported: string[];
}

/** What a connectivity check found. Never contains a secret. */
export interface VoiceCheck {
  ok: boolean;
  /** Short and readable ("voice found; model listed", or why not). */
  detail: string;
  /** The configured voice's name at the provider (null: not found). */
  voiceName?: string | null;
  /** Whether the configured model is among the provider's models (null: could not tell). */
  modelListed?: boolean | null;
}

/** Text-to-speech narration. Vendor-neutral: implementations translate, the engine never writes vendor markup itself. */
export interface VoiceProvider {
  readonly info: ProviderInfo;
  /** Configured defaults (model, voice, output format) for new voice profiles. */
  readonly defaults: { model: string; voiceId: string | null; outputFormat: string };
  /** The provider-specific settings a profile may set, described for forms (which models take each is `sentSettings`'s to say). */
  readonly settings: readonly VoiceSettingDescriptor[];
  /** Known model ids, for a profile's form (another id may still be used: it gets plain text and conservative settings). */
  readonly models: readonly string[];
  capabilities(model: string): VoiceModelCapabilities;
  /**
   * Settings checked and completed: every described key present (defaults
   * filled in); unknown keys and values of the wrong kind or out of range are
   * left out and listed in `problems` — never clamped. Pure.
   */
  normalizeSettings(input: Readonly<Record<string, unknown>>): { settings: ProviderSettingValues; problems: string[] };
  /** What a model is sent of these settings, and the keys it does not take (kept in the record, not sent). Pure. */
  sentSettings(settings: Readonly<ProviderSettingValues>, model: string): { sent: ProviderSettingValues; ignored: string[] };
  /** The chunk's sentences in the model's own markup (pure). */
  render(segments: readonly PerformanceSegment[], model: string): RenderedNarration;
  getVoices(): Promise<Voice[]>;
  generateNarration(req: NarrationRequest): Promise<NarrationResult>;
  getAudioMetadata(audio: Uint8Array, mimeType: string): Promise<AudioMetadata>;
  /** Reach the provider without generating anything (no characters spent): the configured voice and model. */
  check?(): Promise<VoiceCheck>;
}
