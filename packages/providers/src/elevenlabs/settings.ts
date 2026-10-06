import type { VoiceSettingDescriptor } from '@docengine/core';
import { ELEVENLABS_MODELS, UNKNOWN_MODEL, type ElevenLabsModel } from './models.ts';

/**
 * ElevenLabs' voice settings, described for profiles and forms. Which models
 * take each comes from the model table (models.ts, never elevenlabs.ts: the
 * provider imports this file). A setting a model the table does not know
 * takes is "every model but those without it"; otherwise it is exactly the
 * models with it. Sent under ElevenLabs' names: `similarity` as
 * `similarity_boost`, `speakerBoost` as `use_speaker_boost`.
 */

const sentTo = (flag: keyof ElevenLabsModel['settings']): Pick<VoiceSettingDescriptor, 'models' | 'except'> => {
  const known = Object.entries(ELEVENLABS_MODELS);
  if (!UNKNOWN_MODEL.settings[flag]) return { models: known.filter(([, m]) => m.settings[flag]).map(([id]) => id) };
  const except = known.filter(([, m]) => !m.settings[flag]).map(([id]) => id);
  return except.length ? { models: null, except } : { models: null };
};

export const ELEVENLABS_SETTINGS: readonly VoiceSettingDescriptor[] = [
  { key: 'stability', label: 'Stability', help: 'Higher = more consistent, lower = more expressive.', kind: 'NUMBER', default: 0.5, min: 0, max: 1, step: 0.05, ...sentTo('stability'), overridable: true },
  { key: 'similarity', label: 'Similarity', help: 'How closely to keep to the original voice.', kind: 'NUMBER', default: 0.75, min: 0, max: 1, step: 0.05, ...sentTo('similarity'), overridable: true },
  { key: 'style', label: 'Style', help: 'Style exaggeration (0 = none).', kind: 'NUMBER', default: 0, min: 0, max: 1, step: 0.05, ...sentTo('style'), overridable: true },
  { key: 'speakerBoost', label: 'Speaker boost', help: 'Boosts similarity to the original speaker.', kind: 'BOOLEAN', default: true, ...sentTo('speakerBoost'), overridable: true },
  {
    key: 'speed',
    label: 'Speed',
    help: "Base speaking rate (1 = the voice's natural pace); a chunk's pace scales it.",
    kind: 'NUMBER',
    default: 1,
    min: 0.7,
    max: 1.2,
    step: 0.01,
    ...sentTo('speed'),
    overridable: true,
    role: 'SPEED',
  },
];
