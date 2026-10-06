import { DEFAULT_DELIVERY, type Pronunciation } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { ElevenLabsScriptAdapter, narrationRequests, voiceAdapterFor } from './voice-render.ts';

const b = (key: string, text: string, d: Partial<typeof DEFAULT_DELIVERY> = {}) => ({ key, text, delivery: { ...DEFAULT_DELIVERY, ...d } });
const say = (term: string, needsReview: boolean, ipa: string | null = null): Pronunciation => ({ term, respelling: `${term.toUpperCase()}-test`, ipa, language: 'Dutch', confidence: needsReview ? 'LOW' : 'HIGH', note: '', needsReview, source: 'MODEL' });

describe('the ElevenLabs legacy character estimate (no audio, no calls)', () => {
  it('writes no break tags or other markup: the spoken text per run of the same pace, with neighbouring text', () => {
    const plan = new ElevenLabsScriptAdapter().render(
      [
        { key: 'SC01', blocks: [b('1.1', 'It begins quietly.'), b('1.2', 'Then nobody comes.', { pauseBefore: { length: 'MEDIUM', reason: 'REVEAL' }, pauseAfter: { length: 'LONG', reason: 'REVEAL' }, emphasis: [{ text: 'nobody', level: 'STRONG' }] }), b('1.3', 'Prices fall, and fall.', { pace: 'FAST', emotion: 'TENSE' })] },
        { key: 'SC02', blocks: [b('2.1', 'The courts step back.', { pace: 'SLOW' })] },
      ],
      [say('Haarlem', false), say('Proefman', true), say('Alkmaar', false, 'ˈɑlkmaːr')],
    );
    expect(plan.segments.map((s) => ({ section: s.sectionKey, blocks: s.blockKeys, speed: s.speed, text: s.text }))).toEqual([
      { section: 'SC01', blocks: ['1.1', '1.2'], speed: 1, text: 'It begins quietly. Then nobody comes.' },
      { section: 'SC01', blocks: ['1.3'], speed: 1.08, text: 'Prices fall, and fall.' },
      { section: 'SC02', blocks: ['2.1'], speed: 0.92, text: 'The courts step back.' },
    ]);
    expect(plan.segments[1]).toMatchObject({ previousText: 'It begins quietly. Then nobody comes.', nextText: 'The courts step back.' });
    // Characters are what is spoken (tags excluded).
    expect(plan.characters).toBe('It begins quietly. Then nobody comes.'.length + 'Prices fall, and fall.'.length + 'The courts step back.'.length);
    expect(plan.segments.some((seg) => /[<>[\]]/.test(seg.text))).toBe(false);
    // What the estimate leaves to the Voice Engine is listed, not rendered.
    expect(plan.unsupported).toEqual([
      "pauses on 1 block(s): not in this estimate (the Voice Engine writes them in each model's own markup)",
      'emphasis on 1 block(s): not in this estimate',
      'energy or emotion on 1 block(s): not in this estimate (the Voice Engine directs them per chunk)',
    ]);
    expect(plan.notes[0]).toBe('Legacy character estimate: the spoken text only, without markup; the Voice Engine plans the real requests in small chunks');
    // Only confirmed pronunciations are sent; IPA when known, the respelling otherwise.
    expect(plan.dictionary).toEqual([
      { term: 'Haarlem', alias: 'HAARLEM-test', ipa: null },
      { term: 'Alkmaar', alias: null, ipa: 'ˈɑlkmaːr' },
    ]);
    expect(plan.pendingPronunciations).toEqual(['Proefman']);
  });

  it('leaves a long pause out instead of writing SSML, and builds the provider-neutral requests', () => {
    const plan = voiceAdapterFor('elevenlabs').render([{ key: 'SC01', blocks: [b('1.1', 'Wait.', { pauseAfter: { length: 'LONG', reason: 'IMPACT' } })] }], []);
    expect(plan.segments[0]!.text).toBe('Wait.');
    expect(plan.characters).toBe(5);
    const requests = narrationRequests(plan, 'en', { voiceId: 'voice-test', model: 'model-test', stability: 0.5, similarity: 0.75, style: 0, speed: 1 });
    expect(requests).toEqual([{ text: 'Wait.', language: 'en', settings: { voiceId: 'voice-test', model: 'model-test', stability: 0.5, similarity: 0.75, style: 0, speed: 1 }, withTimestamps: true, previousText: undefined, nextText: undefined }]);
    expect(() => voiceAdapterFor('nobody')).toThrow(/No voice rendering adapter for "nobody"/);
  });
});
