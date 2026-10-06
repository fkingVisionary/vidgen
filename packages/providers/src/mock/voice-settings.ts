import type { VoiceSettingDescriptor } from '@docengine/core';

/**
 * The MOCK voice's settings: the same five as before provider settings, for
 * every model, so earlier mock profiles read cleanly. Only speed changes
 * anything (the clip's length).
 */
export const MOCK_VOICE_SETTINGS: readonly VoiceSettingDescriptor[] = [
  { key: 'stability', label: 'Stability', help: 'MOCK: recorded, changes nothing.', kind: 'NUMBER', default: 0.5, min: 0, max: 1, step: 0.05, models: null, overridable: true },
  { key: 'similarity', label: 'Similarity', help: 'MOCK: recorded, changes nothing.', kind: 'NUMBER', default: 0.75, min: 0, max: 1, step: 0.05, models: null, overridable: true },
  { key: 'style', label: 'Style', help: 'MOCK: recorded, changes nothing.', kind: 'NUMBER', default: 0, min: 0, max: 1, step: 0.05, models: null, overridable: true },
  { key: 'speakerBoost', label: 'Speaker boost', help: 'MOCK: recorded, changes nothing.', kind: 'BOOLEAN', default: true, models: null, overridable: true },
  { key: 'speed', label: 'Speed', help: "MOCK: base speaking rate (1 = 150 words a minute); a chunk's pace scales it.", kind: 'NUMBER', default: 1, min: 0.7, max: 1.2, step: 0.01, models: null, overridable: true, role: 'SPEED' },
];
