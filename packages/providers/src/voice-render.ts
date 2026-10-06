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
 * The Script page's legacy character estimate for ElevenLabs: the spoken
 * text in one segment per run of blocks with the same pace, neighbouring
 * text, and the pronunciation dictionary it would use. It writes no markup
 * (no SSML `<break>`, no tags) and lists the pauses, emphasis, energy and
 * emotion it leaves out. Narration itself goes through the Voice Engine
 * (modules/voice), which chunks smaller and renders each model's own markup
 * through the provider (audio tags and no SSML for tag models).
 */
export class ElevenLabsScriptAdapter implements VoiceScriptAdapter {
  readonly provider = 'elevenlabs';
  static readonly SPEED: Record<DeliveryPace, number> = { SLOW: 0.92, NORMAL: 1, FAST: 1.08 };

  render(sections: readonly VoiceScriptSection[], pronunciations: readonly Pronunciation[]): VoiceRenderPlan {
    const segments: VoiceSegment[] = [];
    let paused = 0;
    let emphasis = 0;
    let coloured = 0;
    for (const s of sections) {
      // One segment per run of blocks with the same pace (speed is per request).
      let run: VoiceScriptSection['blocks'][number][] = [];
      const flush = () => {
        if (!run.length) return;
        const text = run.map((b) => b.text).join(' ').trim();
        segments.push({ sectionKey: s.key, blockKeys: run.map((b) => b.key), text, speed: ElevenLabsScriptAdapter.SPEED[run[0]!.delivery.pace], characters: plain(text).length, previousText: null, nextText: null });
        run = [];
      };
      for (const b of s.blocks) {
        if (pauseSec(b.delivery.pauseBefore) > 0 || pauseSec(b.delivery.pauseAfter) > 0) paused++;
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
      paused ? `pauses on ${paused} block(s): not in this estimate (the Voice Engine writes them in each model's own markup)` : null,
      emphasis ? `emphasis on ${emphasis} block(s): not in this estimate` : null,
      coloured ? `energy or emotion on ${coloured} block(s): not in this estimate (the Voice Engine directs them per chunk)` : null,
    ].filter((x): x is string => x !== null);
    return {
      provider: this.provider,
      segments,
      dictionary: confirmed.map((p) => ({ term: p.term, alias: p.ipa ? null : p.respelling || null, ipa: p.ipa })),
      unsupported,
      pendingPronunciations: pronunciations.filter((p) => p.needsReview).map((p) => p.term),
      characters: segments.reduce((n, s) => n + s.characters, 0),
      notes: [
        'Legacy character estimate: the spoken text only, without markup; the Voice Engine plans the real requests in small chunks',
        `${segments.length} segment(s): one per run of blocks with the same pace in a section`,
        'Only confirmed pronunciations go into the dictionary',
      ],
    };
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
