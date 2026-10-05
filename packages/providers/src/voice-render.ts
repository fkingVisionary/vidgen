import { pauseSec, type DeliveryPace, type Pronunciation, type ScriptBlockContent, type VoiceRenderPlan, type VoiceSegment } from '@docengine/core';
import type { NarrationRequest, NarrationSettings } from './voice.ts';

/**
 * Voice rendering adapters: Script → adapter → voice provider. The script
 * stays provider-neutral (pace, energy, emotion, emphasis, semantic pauses,
 * pronunciation notes); an adapter translates it into what one provider
 * accepts, and says what that provider cannot express. Adapters are pure —
 * they generate no audio and call nothing.
 */

export interface VoiceScriptSection {
  key: string;
  blocks: readonly Pick<ScriptBlockContent, 'key' | 'text' | 'delivery'>[];
}

export interface VoiceScriptAdapter {
  readonly provider: string;
  render(sections: readonly VoiceScriptSection[], pronunciations: readonly Pronunciation[]): VoiceRenderPlan;
}

/** Text without provider markup (what the listener hears, for context fields and counts). */
const plain = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tail = (s: string, n: number) => (s.length > n ? s.slice(s.length - n) : s);
const head = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/**
 * ElevenLabs (multilingual / turbo / flash v2 models), as documented by the
 * provider: pauses as `<break time="1.2s" />` (up to 3 s), one speed per
 * request (0.7–1.2), neighbouring text for continuous prosody, and
 * pronunciation dictionaries (alias or IPA rules). Emphasis, energy and
 * emotion have no markup in these models: they are reported as unsupported
 * and kept in the script for a later adapter. Not yet exercised against the
 * live API — no ElevenLabs provider exists in this system yet.
 */
export class ElevenLabsScriptAdapter implements VoiceScriptAdapter {
  readonly provider = 'elevenlabs';
  static readonly SPEED: Record<DeliveryPace, number> = { SLOW: 0.92, NORMAL: 1, FAST: 1.08 };
  static readonly MAX_BREAK_SEC = 3;

  render(sections: readonly VoiceScriptSection[], pronunciations: readonly Pronunciation[]): VoiceRenderPlan {
    const segments: VoiceSegment[] = [];
    let emphasis = 0;
    let coloured = 0;
    for (const s of sections) {
      // One request per run of blocks with the same pace (speed is per request).
      let run: VoiceScriptSection['blocks'][number][] = [];
      const flush = () => {
        if (!run.length) return;
        const text = run
          .map((b) => [this.pause(pauseSec(b.delivery.pauseBefore)), b.text, this.pause(pauseSec(b.delivery.pauseAfter))].filter(Boolean).join(' '))
          .join(' ')
          .trim();
        segments.push({ sectionKey: s.key, blockKeys: run.map((b) => b.key), text, speed: ElevenLabsScriptAdapter.SPEED[run[0]!.delivery.pace], characters: plain(text).length, previousText: null, nextText: null });
        run = [];
      };
      for (const b of s.blocks) {
        if (b.delivery.emphasis.length) emphasis++;
        if (b.delivery.emotion !== 'NEUTRAL' || b.delivery.energy !== 'MEDIUM') coloured++;
        if (run.length && run[0]!.delivery.pace !== b.delivery.pace) flush();
        run.push(b);
      }
      flush();
    }
    // Neighbouring text keeps the prosody continuous across requests.
    segments.forEach((seg, i) => {
      seg.previousText = i > 0 ? tail(plain(segments[i - 1]!.text), 300) : null;
      seg.nextText = i < segments.length - 1 ? head(plain(segments[i + 1]!.text), 300) : null;
    });
    const confirmed = pronunciations.filter((p) => !p.needsReview);
    const unsupported = [
      emphasis ? `emphasis on ${emphasis} block(s): no emphasis markup in these models` : null,
      coloured ? `energy or emotion on ${coloured} block(s): not expressible per block; choose the voice and settings for the overall register` : null,
    ].filter((x): x is string => x !== null);
    return {
      provider: this.provider,
      segments,
      dictionary: confirmed.map((p) => ({ term: p.term, alias: p.ipa ? null : p.respelling || null, ipa: p.ipa })),
      unsupported,
      pendingPronunciations: pronunciations.filter((p) => p.needsReview).map((p) => p.term),
      characters: segments.reduce((n, s) => n + s.characters, 0),
      notes: [
        `${segments.length} request(s): one per run of blocks with the same pace in a section`,
        `Pauses as break tags (up to ${ElevenLabsScriptAdapter.MAX_BREAK_SEC} s); characters exclude the tags`,
        'Only confirmed pronunciations go into the dictionary',
      ],
    };
  }

  private pause(sec: number): string {
    if (sec <= 0) return '';
    return `<break time="${Math.min(sec, ElevenLabsScriptAdapter.MAX_BREAK_SEC).toFixed(1)}s" />`;
  }
}

/** The requests a voice provider would receive for a render plan (no call is made). */
export function narrationRequests(plan: VoiceRenderPlan, language: string, settings: NarrationSettings): NarrationRequest[] {
  return plan.segments.map((s) => ({ text: s.text, language, settings: { ...settings, speed: settings.speed * s.speed }, withTimestamps: true, previousText: s.previousText ?? undefined, nextText: s.nextText ?? undefined }));
}

const ADAPTERS: Record<string, () => VoiceScriptAdapter> = { elevenlabs: () => new ElevenLabsScriptAdapter() };

/** The adapter for a voice provider name; ElevenLabs is the planned provider. */
export function voiceAdapterFor(provider = 'elevenlabs'): VoiceScriptAdapter {
  const make = ADAPTERS[provider];
  if (!make) throw new Error(`No voice rendering adapter for "${provider}" (available: ${Object.keys(ADAPTERS).join(', ')})`);
  return make();
}
