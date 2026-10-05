import { DEFAULT_DELIVERY, type Pronunciation } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { ElevenLabsScriptAdapter, narrationRequests, voiceAdapterFor } from './voice-render.ts';

const b = (key: string, text: string, d: Partial<typeof DEFAULT_DELIVERY> = {}) => ({ key, text, delivery: { ...DEFAULT_DELIVERY, ...d } });
const say = (term: string, needsReview: boolean, ipa: string | null = null): Pronunciation => ({ term, respelling: `${term.toUpperCase()}-test`, ipa, language: 'Dutch', confidence: needsReview ? 'LOW' : 'HIGH', note: '', needsReview, source: 'MODEL' });

describe('the ElevenLabs voice adapter (no audio, no calls)', () => {
  it('turns semantic pauses into break tags, one request per run of the same pace, with neighbouring text', () => {
    const plan = new ElevenLabsScriptAdapter().render(
      [
        { key: 'SC01', blocks: [b('1.1', 'It begins quietly.'), b('1.2', 'Then nobody comes.', { pauseBefore: { length: 'MEDIUM', reason: 'REVEAL' }, pauseAfter: { length: 'LONG', reason: 'REVEAL' }, emphasis: [{ text: 'nobody', level: 'STRONG' }] }), b('1.3', 'Prices fall, and fall.', { pace: 'FAST', emotion: 'TENSE' })] },
        { key: 'SC02', blocks: [b('2.1', 'The courts step back.', { pace: 'SLOW' })] },
      ],
      [say('Haarlem', false), say('Proefman', true), say('Alkmaar', false, 'ˈɑlkmaːr')],
    );
    expect(plan.segments.map((s) => ({ section: s.sectionKey, blocks: s.blockKeys, speed: s.speed, text: s.text }))).toEqual([
      { section: 'SC01', blocks: ['1.1', '1.2'], speed: 1, text: 'It begins quietly. <break time="1.2s" /> Then nobody comes. <break time="2.0s" />' },
      { section: 'SC01', blocks: ['1.3'], speed: 1.08, text: 'Prices fall, and fall.' },
      { section: 'SC02', blocks: ['2.1'], speed: 0.92, text: 'The courts step back.' },
    ]);
    expect(plan.segments[1]).toMatchObject({ previousText: 'It begins quietly. Then nobody comes.', nextText: 'The courts step back.' });
    // Characters are what is spoken (tags excluded).
    expect(plan.characters).toBe('It begins quietly. Then nobody comes.'.length + 'Prices fall, and fall.'.length + 'The courts step back.'.length);
    expect(plan.unsupported).toEqual(['emphasis on 1 block(s): no emphasis markup in these models', 'energy or emotion on 1 block(s): not expressible per block; choose the voice and settings for the overall register']);
    // Only confirmed pronunciations are sent; IPA when known, the respelling otherwise.
    expect(plan.dictionary).toEqual([
      { term: 'Haarlem', alias: 'HAARLEM-test', ipa: null },
      { term: 'Alkmaar', alias: null, ipa: 'ˈɑlkmaːr' },
    ]);
    expect(plan.pendingPronunciations).toEqual(['Proefman']);
  });

  it('caps a pause at what the provider accepts, and builds the provider-neutral requests', () => {
    const plan = voiceAdapterFor('elevenlabs').render([{ key: 'SC01', blocks: [b('1.1', 'Wait.', { pauseAfter: { length: 'LONG', reason: 'IMPACT' } })] }], []);
    expect(plan.segments[0]!.text).toBe('Wait. <break time="2.0s" />');
    const requests = narrationRequests(plan, 'en', { voiceId: 'voice-test', model: 'model-test', stability: 0.5, similarity: 0.75, style: 0, speed: 1 });
    expect(requests).toEqual([{ text: 'Wait. <break time="2.0s" />', language: 'en', settings: { voiceId: 'voice-test', model: 'model-test', stability: 0.5, similarity: 0.75, style: 0, speed: 1 }, withTimestamps: true, previousText: undefined, nextText: undefined }]);
    expect(() => voiceAdapterFor('nobody')).toThrow(/No voice rendering adapter for "nobody"/);
  });
});
