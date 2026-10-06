import type { VoiceModelCapabilities } from '../voice.ts';

/**
 * ElevenLabs' models: what each can express (see elevenlabs.ts for the
 * sources), and which of ElevenLabs' voice settings it takes. The settings
 * flags are ElevenLabs' own: the engine reads them through `sentSettings`.
 * Its own module so that both the provider and its setting descriptors can
 * import the table without importing each other.
 */
export type ElevenLabsModel = Omit<VoiceModelCapabilities, 'model'> & {
  /** Voice settings the model takes (the rest are not sent). */
  settings: { stability: boolean; similarity: boolean; style: boolean; speakerBoost: boolean; speed: boolean };
};

const TAG_MODEL = {
  directions: true,
  pauses: 'TAGS',
  settings: { stability: true, similarity: true, style: false, speakerBoost: false, speed: false },
  phonemes: true,
  contextText: true,
  stitching: true,
  languageCode: true,
  maxCharacters: 10_000,
  known: true,
} as const satisfies ElevenLabsModel;

const SSML_MODEL = {
  directions: false,
  pauses: 'BREAKS',
  settings: { stability: true, similarity: true, style: true, speakerBoost: true, speed: true },
  phonemes: false,
  contextText: true,
  stitching: true,
  languageCode: false,
  maxCharacters: 10_000,
  known: true,
} as const satisfies ElevenLabsModel;

export const ELEVENLABS_MODELS: Record<string, ElevenLabsModel> = {
  eleven_v4: TAG_MODEL,
  eleven_v4_turbo: TAG_MODEL,
  // v3: tags, no SSML; request stitching is documented as unavailable, neighbouring text is not documented either way.
  eleven_v3: { ...TAG_MODEL, settings: { ...TAG_MODEL.settings, similarity: false }, contextText: false, stitching: false, maxCharacters: 5_000 },
  eleven_multilingual_v2: SSML_MODEL,
  eleven_flash_v2_5: { ...SSML_MODEL, languageCode: true, maxCharacters: 40_000 },
  eleven_flash_v2: { ...SSML_MODEL, phonemes: true, maxCharacters: 30_000 },
};

/** A model this table does not know: plain text (no tags, no SSML) and only stability and similarity. */
export const UNKNOWN_MODEL: ElevenLabsModel = {
  directions: false,
  pauses: 'PUNCTUATION',
  settings: { stability: true, similarity: true, style: false, speakerBoost: false, speed: false },
  phonemes: false,
  contextText: false,
  stitching: false,
  languageCode: false,
  maxCharacters: 5_000,
  known: false,
};
