import type { AudioMetadata, NarrationRequest, NarrationResult, Voice, VoiceProvider, WordTiming } from '../voice.ts';
import { ProviderError } from '../types.ts';
import { MOCK_FAIL_MARKER, MOCK_LABEL, mockInfo, mockMeta } from './common.ts';
import { parseWav, synthesizeMockNarration } from './wav.ts';

/** Typical documentary narration pace at speed 1.0. */
export const MOCK_WORDS_PER_MINUTE = 150;

/**
 * MOCK narration: returns a real WAV (a short beep, then silence) whose
 * duration matches what the text would take to read aloud, plus evenly spaced
 * word timestamps. No speech is synthesised.
 */
export class MockVoiceProvider implements VoiceProvider {
  readonly info = mockInfo('VOICE');

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'mock-narrator-deep', name: `[${MOCK_LABEL}] Deep documentary narrator`, language: 'en' },
      { id: 'mock-narrator-warm', name: `[${MOCK_LABEL}] Warm documentary narrator`, language: 'en' },
    ];
  }

  async generateNarration(req: NarrationRequest): Promise<NarrationResult> {
    if (req.text.includes(MOCK_FAIL_MARKER)) throw new ProviderError('mock', 'Simulated TTS failure', true);
    const words = req.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) throw new ProviderError('mock', 'Narration text is empty', false);

    const msPerWord = 60_000 / (MOCK_WORDS_PER_MINUTE * req.settings.speed);
    const durationMs = Math.round(words.length * msPerWord);
    const alignment: WordTiming[] | null = req.withTimestamps
      ? words.map((word, i) => ({ word, startMs: Math.round(i * msPerWord), endMs: Math.round((i + 1) * msPerWord) }))
      : null;

    return {
      audio: synthesizeMockNarration(durationMs),
      mimeType: 'audio/wav',
      durationMs,
      alignment,
      meta: mockMeta([{ unit: 'CHARACTERS', quantity: req.text.length }], req.settings.model),
    };
  }

  async getAudioMetadata(audio: Uint8Array, mimeType: string): Promise<AudioMetadata> {
    if (mimeType !== 'audio/wav' && mimeType !== 'audio/x-wav') {
      throw new ProviderError('mock', `MOCK voice provider can only inspect WAV audio, got ${mimeType}`, false);
    }
    const info = parseWav(audio);
    return { durationMs: info.durationMs, sampleRate: info.sampleRate, channels: info.channels, bitDepth: info.bitDepth, format: 'wav' };
  }
}
