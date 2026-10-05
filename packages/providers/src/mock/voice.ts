import { audioMetadata } from '../audio.ts';
import { ProviderError } from '../types.ts';
import { renderSegments } from '../voice-markup.ts';
import type { AudioMetadata, CharacterAlignment, NarrationRequest, NarrationResult, PerformanceSegment, RenderedNarration, Voice, VoiceModelCapabilities, VoiceProvider, WordTiming } from '../voice.ts';
import { MOCK_FAIL_MARKER, MOCK_LABEL, mockId, mockInfo, mockMeta } from './common.ts';
import { synthesizeMockNarration } from './wav.ts';

/** Typical documentary narration pace at speed 1.0. */
export const MOCK_WORDS_PER_MINUTE = 150;

/** Silence the mock leaves for a pause tag. */
const MOCK_PAUSE_MS: Record<string, number> = { '[pause]': 500, '[long pause]': 1100 };

const MOCK_CAPABILITIES: Omit<VoiceModelCapabilities, 'model'> = {
  directions: true,
  pauses: 'TAGS',
  settings: { stability: true, similarity: true, style: true, speakerBoost: true, speed: true },
  phonemes: true,
  contextText: true,
  stitching: true,
  languageCode: true,
  maxCharacters: 10_000,
  known: true,
};

/**
 * MOCK narration: returns a real WAV (a short beep, then silence) whose
 * duration matches what the text would take to read aloud, with character
 * timestamps shaped like a tag-aware provider's (markup characters take no
 * time; pause tags leave silence). No speech is synthesised.
 */
export class MockVoiceProvider implements VoiceProvider {
  readonly info = mockInfo('VOICE');
  readonly defaults = { model: 'mock', voiceId: 'mock-narrator-deep', outputFormat: 'wav_22050' };

  capabilities(model: string): VoiceModelCapabilities {
    return { model, ...MOCK_CAPABILITIES };
  }

  render(segments: readonly PerformanceSegment[], model: string): RenderedNarration {
    return renderSegments(segments, this.capabilities(model));
  }

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'mock-narrator-deep', name: `[${MOCK_LABEL}] Deep documentary narrator`, language: 'en' },
      { id: 'mock-narrator-warm', name: `[${MOCK_LABEL}] Warm documentary narrator`, language: 'en' },
    ];
  }

  async generateNarration(req: NarrationRequest): Promise<NarrationResult> {
    if (req.text.includes(MOCK_FAIL_MARKER)) throw new ProviderError('mock', 'Simulated TTS failure', true);
    if (!req.text.replace(/\[[^\]]*\]/g, '').trim()) throw new ProviderError('mock', 'Narration text is empty', false);

    const msPerWord = 60_000 / (MOCK_WORDS_PER_MINUTE * (req.settings.speed || 1));
    const chars: string[] = [];
    const startMs: number[] = [];
    const endMs: number[] = [];
    let clock = 0;
    const text = req.text;
    for (let i = 0; i < text.length; ) {
      if (text[i] === '[') {
        // Markup: its characters take no time; a pause tag leaves silence after it.
        const close = text.indexOf(']', i);
        const tag = close === -1 ? text.slice(i) : text.slice(i, close + 1);
        for (const ch of tag) {
          chars.push(ch);
          startMs.push(Math.round(clock));
          endMs.push(Math.round(clock));
        }
        clock += MOCK_PAUSE_MS[tag] ?? 0;
        i += tag.length;
        continue;
      }
      const m = /^[^\s[]+/.exec(text.slice(i));
      if (m) {
        // A word: its characters share the word's time evenly.
        const w = m[0];
        const per = msPerWord / w.length;
        for (const ch of w) {
          chars.push(ch);
          startMs.push(Math.round(clock));
          clock += per;
          endMs.push(Math.round(clock));
        }
        i += w.length;
        continue;
      }
      chars.push(text[i]!);
      startMs.push(Math.round(clock));
      endMs.push(Math.round(clock));
      i++;
    }
    const durationMs = Math.round(clock + 200);
    const characters: CharacterAlignment | null = req.withTimestamps ? { chars, startMs, endMs } : null;
    const audio = synthesizeMockNarration(durationMs);
    return {
      audio,
      mimeType: 'audio/wav',
      durationMs: audioMetadata(audio, 'audio/wav').durationMs,
      alignment: characters ? mockWords(characters) : null,
      characters,
      requestId: mockId('tts'),
      dictionary: null,
      meta: mockMeta([{ unit: 'CHARACTERS', quantity: req.text.length }], req.settings.model),
    };
  }

  async getAudioMetadata(audio: Uint8Array, mimeType: string): Promise<AudioMetadata> {
    if (mimeType !== 'audio/wav' && mimeType !== 'audio/x-wav') {
      throw new ProviderError('mock', `MOCK voice provider can only inspect WAV audio, got ${mimeType}`, false);
    }
    return audioMetadata(audio, mimeType);
  }
}

function mockWords(c: CharacterAlignment): WordTiming[] {
  const out: WordTiming[] = [];
  let word = '';
  let start = 0;
  let end = 0;
  let inTag = false;
  c.chars.forEach((ch, i) => {
    if (ch === '[') inTag = true;
    if (inTag) {
      if (ch === ']') inTag = false;
      return;
    }
    if (/\s/.test(ch)) {
      if (word) out.push({ word, startMs: start, endMs: end });
      word = '';
      return;
    }
    if (!word) start = c.startMs[i]!;
    word += ch;
    end = c.endMs[i]!;
  });
  if (word) out.push({ word, startMs: start, endMs: end });
  return out;
}
