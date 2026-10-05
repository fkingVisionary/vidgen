import { createHash } from 'node:crypto';
import type { Rate } from '@docengine/core';
import { audioMetadata, pcmToWav } from '../audio.ts';
import { ProviderError, type CallMeta, type ProviderInfo } from '../types.ts';
import { renderSegments } from '../voice-markup.ts';
import type {
  AudioMetadata,
  CharacterAlignment,
  NarrationRequest,
  NarrationResult,
  PerformanceSegment,
  PronunciationRule,
  RenderedNarration,
  Voice,
  VoiceModelCapabilities,
  VoiceProvider,
  WordTiming,
} from '../voice.ts';

/**
 * ElevenLabs text to speech (https://elevenlabs.io/docs) — the only place in
 * the codebase that knows ElevenLabs' API. Checked against the docs on
 * 2026-10-05:
 *
 * - POST /v1/text-to-speech/{voice_id}/with-timestamps returns base64 audio
 *   and character timestamps for the text it received.
 * - Eleven v4 (`eleven_v4`, the production default here) takes bracketed
 *   natural-language audio tags for performance, `[pause]` / `[long pause]`
 *   for pauses, and NO SSML (`<break>` is disabled). Its only voice settings
 *   are stability and similarity: style and speed are not sent to it.
 *   It supports request stitching (earlier request ids as context) and
 *   phoneme rules (IPA/CMU) in pronunciation dictionaries; 10,000 characters
 *   per request.
 * - Multilingual / Flash v2 models take `<break time="…"/>` (≤ 3 s), speed
 *   and style, but no audio tags.
 * - Text to speech is billed per character; the `character-cost` response
 *   header reports a generation's characters where ElevenLabs returns it.
 *   The API reports characters, not dollars: every cost is an ESTIMATE =
 *   characters × the configured price (ELEVENLABS_USD_PER_1K_CHARS) or the
 *   documented list price for the model.
 *
 * A model this table does not know gets plain text (no tags, no SSML) and
 * only stability and similarity, so nothing it would read aloud or reject
 * is ever sent. There is no automatic fallback to another model.
 */

export interface ElevenLabsOptions {
  apiKey?: string;
  /** Default model for new voice profiles. */
  model: string;
  /** Default voice for new voice profiles (null: choose one in the dashboard). */
  voiceId?: string | null;
  /** Default output format for new voice profiles. */
  outputFormat: string;
  /** Overrides the documented list price (USD per 1,000 characters), e.g. for a plan's actual rate. */
  usdPer1kChars?: number;
  baseUrl?: string;
  timeoutMs?: number;
  /** Retries inside one call for rate limits, 5xx and network failures. */
  maxRetries?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Injectable for tests (backoff between retries). */
  sleep?: (ms: number) => Promise<void>;
}

const PRICING_SOURCE = 'elevenlabs.io/pricing/api (checked 2026-10-05; list price — v4 had a launch price of $0.022 until 2026-10-12)';

/** Documented API list prices, USD per 1,000 characters. */
export const ELEVENLABS_PRICES_PER_1K: Record<string, number> = {
  eleven_v4: 0.08,
  eleven_v4_turbo: 0.04,
  eleven_v3: 0.08,
  eleven_v3_conversational: 0.04,
  eleven_multilingual_v2: 0.08,
  eleven_flash_v2_5: 0.04,
  eleven_flash_v2: 0.04,
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
} as const satisfies Omit<VoiceModelCapabilities, 'model'>;

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
} as const satisfies Omit<VoiceModelCapabilities, 'model'>;

export const ELEVENLABS_MODELS: Record<string, Omit<VoiceModelCapabilities, 'model'>> = {
  eleven_v4: TAG_MODEL,
  eleven_v4_turbo: TAG_MODEL,
  // v3: tags, no SSML; request stitching is documented as unavailable, neighbouring text is not documented either way.
  eleven_v3: { ...TAG_MODEL, settings: { ...TAG_MODEL.settings, similarity: false }, contextText: false, stitching: false, maxCharacters: 5_000 },
  eleven_multilingual_v2: SSML_MODEL,
  eleven_flash_v2_5: { ...SSML_MODEL, languageCode: true, maxCharacters: 40_000 },
  eleven_flash_v2: { ...SSML_MODEL, phonemes: true, maxCharacters: 30_000 },
};

const UNKNOWN_MODEL: Omit<VoiceModelCapabilities, 'model'> = {
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

/** Output formats the engine can measure and join without transcoding. */
const OUTPUT_FORMAT = /^(mp3)_(\d+)_(\d+)$|^(pcm|wav)_(\d+)$/;

export function parseOutputFormat(format: string): { mimeType: string; container: 'mp3' | 'pcm' | 'wav'; sampleRate: number } {
  const m = OUTPUT_FORMAT.exec(format);
  if (!m) throw new ProviderError('elevenlabs', `Output format "${format}" is not supported here (use mp3_*, wav_* or pcm_*: opus and µ-law cannot be measured or joined without transcoding)`, false);
  if (m[1]) return { mimeType: 'audio/mpeg', container: 'mp3', sampleRate: Number(m[2]) };
  return { mimeType: 'audio/wav', container: m[4] as 'pcm' | 'wav', sampleRate: Number(m[5]) };
}

interface TimestampsResponse {
  audio_base64?: unknown;
  alignment?: { characters?: unknown; character_start_times_seconds?: unknown; character_end_times_seconds?: unknown } | null;
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly info: ProviderInfo;
  readonly defaults: { model: string; voiceId: string | null; outputFormat: string };
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Pronunciation dictionaries created in this process, by rule-set hash. */
  private readonly dictionaries = new Map<string, Promise<{ id: string; version: string }>>();

  constructor(private readonly opts: ElevenLabsOptions) {
    if (!opts.apiKey) throw new ProviderError('elevenlabs', 'ELEVENLABS_API_KEY is not set', false);
    parseOutputFormat(opts.outputFormat);
    const rates: Rate[] =
      opts.usdPer1kChars !== undefined
        ? [{ provider: 'elevenlabs', unit: 'CHARACTERS', usdPerUnit: opts.usdPer1kChars / 1000, source: 'ELEVENLABS_USD_PER_1K_CHARS' }]
        : Object.entries(ELEVENLABS_PRICES_PER_1K).map(([model, usd]) => ({ provider: 'elevenlabs', model, unit: 'CHARACTERS', usdPerUnit: usd / 1000, source: PRICING_SOURCE }));
    this.info = { kind: 'VOICE', name: 'elevenlabs', mock: false, rates };
    this.defaults = { model: opts.model, voiceId: opts.voiceId ?? null, outputFormat: opts.outputFormat };
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  capabilities(model: string): VoiceModelCapabilities {
    return { model, ...(ELEVENLABS_MODELS[model] ?? UNKNOWN_MODEL) };
  }

  render(segments: readonly PerformanceSegment[], model: string): RenderedNarration {
    return renderSegments(segments, this.capabilities(model));
  }

  async getVoices(): Promise<Voice[]> {
    const data = await this.request<{ voices?: { voice_id: string; name?: string; description?: string | null; preview_url?: string | null; labels?: Record<string, string> }[] }>('GET', '/v2/voices?page_size=100');
    return (data.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name ?? v.voice_id,
      ...(v.labels?.language ? { language: v.labels.language } : {}),
      ...(v.description ? { description: v.description } : {}),
      ...(v.preview_url ? { previewUrl: v.preview_url } : {}),
    }));
  }

  async generateNarration(req: NarrationRequest): Promise<NarrationResult> {
    const model = req.settings.model;
    const caps = this.capabilities(model);
    if (!req.text.trim()) throw new ProviderError('elevenlabs', 'Narration text is empty', false);
    if (req.text.length > caps.maxCharacters) throw new ProviderError('elevenlabs', `${req.text.length} characters exceed ${model}'s limit of ${caps.maxCharacters} per request`, false);
    const format = req.outputFormat ?? this.opts.outputFormat;
    const { mimeType, container, sampleRate } = parseOutputFormat(format);

    const voiceSettings: Record<string, unknown> = {};
    if (caps.settings.stability) voiceSettings.stability = req.settings.stability;
    if (caps.settings.similarity) voiceSettings.similarity_boost = req.settings.similarity;
    if (caps.settings.style) voiceSettings.style = req.settings.style;
    if (caps.settings.speakerBoost && req.settings.speakerBoost !== undefined) voiceSettings.use_speaker_boost = req.settings.speakerBoost;
    if (caps.settings.speed) voiceSettings.speed = req.settings.speed;
    const body: Record<string, unknown> = { text: req.text, model_id: model, voice_settings: voiceSettings };
    if (caps.languageCode && req.language) body.language_code = req.language;
    if (req.seed !== undefined) body.seed = req.seed;
    if (caps.stitching && req.previousRequestIds?.length) body.previous_request_ids = req.previousRequestIds.slice(-3);
    else if (caps.contextText) {
      if (req.previousText) body.previous_text = req.previousText;
      if (req.nextText) body.next_text = req.nextText;
    }
    let dictionary: { id: string; version: string } | null = null;
    const rules = caps.phonemes ? (req.pronunciations ?? []) : [];
    if (rules.length) {
      dictionary = await this.dictionaryFor(rules);
      body.pronunciation_dictionary_locators = [{ pronunciation_dictionary_id: dictionary.id, version_id: dictionary.version }];
    }

    const path = `/v1/text-to-speech/${encodeURIComponent(req.settings.voiceId)}/with-timestamps?output_format=${encodeURIComponent(format)}`;
    const { data, headers } = await this.requestWithHeaders<TimestampsResponse>('POST', path, body, req.signal);
    if (typeof data.audio_base64 !== 'string' || !data.audio_base64) throw new ProviderError('elevenlabs', 'Response had no audio', true);
    let audio: Uint8Array = new Uint8Array(Buffer.from(data.audio_base64, 'base64'));
    if (container === 'pcm') audio = pcmToWav(audio, sampleRate);
    let durationMs: number;
    try {
      durationMs = audioMetadata(audio, mimeType).durationMs;
    } catch (err) {
      throw new ProviderError('elevenlabs', `Returned audio could not be read as ${format}: ${err instanceof Error ? err.message : String(err)}`, true, { cause: err });
    }
    const characters = parseAlignment(data.alignment);
    const requestId = headers.get('request-id') ?? headers.get('x-trace-id') ?? undefined;
    const reported = Number(headers.get('character-cost') ?? Number.NaN);
    const counted = Number.isFinite(reported) && reported >= 0;
    const meta: CallMeta = {
      provider: 'elevenlabs',
      model,
      mock: false,
      usage: [{ unit: 'CHARACTERS', quantity: counted ? reported : req.text.length }],
      costNote: counted ? `${reported} character(s) reported by ElevenLabs (character-cost)` : `ElevenLabs reported no character cost: ${req.text.length} character(s) counted as sent`,
      ...(requestId ? { providerRequestId: requestId } : {}),
    };
    return { audio, mimeType, durationMs, alignment: characters ? wordTimings(characters) : null, characters, ...(requestId ? { requestId } : {}), dictionary, meta };
  }

  async getAudioMetadata(audio: Uint8Array, mimeType: string): Promise<AudioMetadata> {
    try {
      return audioMetadata(audio, mimeType);
    } catch (err) {
      throw new ProviderError('elevenlabs', err instanceof Error ? err.message : String(err), false);
    }
  }

  /** A pronunciation dictionary holding exactly these phoneme rules (created once per rule set and process). */
  private dictionaryFor(rules: readonly PronunciationRule[]): Promise<{ id: string; version: string }> {
    const sorted = [...rules].sort((a, b) => a.term.localeCompare(b.term));
    const hash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
    let pending = this.dictionaries.get(hash);
    if (!pending) {
      pending = this.request<{ id?: string; version_id?: string }>('POST', '/v1/pronunciation-dictionaries/add-from-rules', {
        name: `docengine-${hash}`,
        description: 'Pronunciations approved in the Documentary Engine review list',
        rules: sorted.map((r) => ({
          string_to_replace: r.term,
          type: 'phoneme',
          phoneme: r.method === 'IPA' ? `/${r.pronunciation.replace(/^\/|\/$/g, '')}/` : r.pronunciation,
          alphabet: r.method === 'IPA' ? 'ipa' : 'cmu-arpabet',
        })),
      }).then((d) => {
        if (!d.id || !d.version_id) throw new ProviderError('elevenlabs', 'Pronunciation dictionary response had no id or version', false);
        return { id: d.id, version: d.version_id };
      });
      pending.catch(() => this.dictionaries.delete(hash));
      this.dictionaries.set(hash, pending);
    }
    return pending;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, body, signal)).data;
  }

  private async requestWithHeaders<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<{ data: T; headers: Headers }> {
    const op = path.split('?')[0]!.replace(/\/[A-Za-z0-9]{16,}(?=\/|$)/g, '/{id}');
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: { 'xi-api-key': this.opts.apiKey!, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw new ProviderError('elevenlabs', `${op}: cancelled`, false, { cause: err });
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        const failure = new ProviderError('elevenlabs', `${op}: ${timedOut ? `timed out after ${this.timeoutMs} ms` : `request failed: ${err instanceof Error ? err.message : String(err)}`}`, true, { cause: err });
        if (attempt < this.maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw failure;
      }
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const error = new ProviderError('elevenlabs', `${op}: HTTP ${res.status}: ${errorDetail(text)}`, retryable);
        if (retryable && attempt < this.maxRetries) {
          const after = Number(res.headers.get('retry-after'));
          await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : backoff(attempt));
          continue;
        }
        throw error;
      }
      try {
        return { data: JSON.parse(text) as T, headers: res.headers };
      } catch (err) {
        throw new ProviderError('elevenlabs', `${op}: response was not valid JSON`, true, { cause: err });
      }
    }
  }
}

const backoff = (attempt: number) => 1000 * 3 ** attempt;

/** The message in an ElevenLabs error body (`{detail: {code, message}}`, or a 422 list), else the raw text. */
function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    const d = parsed.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return d.map((x: { loc?: unknown[]; msg?: string }) => `${(x.loc ?? []).join('.')}: ${x.msg ?? ''}`).join('; ');
    if (d && typeof d === 'object') {
      const o = d as { code?: string; status?: string; message?: string };
      return [o.code ?? o.status, o.message].filter(Boolean).join(': ') || text.slice(0, 300);
    }
  } catch {
    // not JSON
  }
  return text.slice(0, 300) || 'no details';
}

function parseAlignment(a: TimestampsResponse['alignment']): CharacterAlignment | null {
  if (!a) return null;
  const chars = a.characters;
  const starts = a.character_start_times_seconds;
  const ends = a.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends) || chars.length === 0) return null;
  if (starts.length !== chars.length || ends.length !== chars.length) return null;
  if (![...starts, ...ends].every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  return { chars: chars.map(String), startMs: (starts as number[]).map((s) => Math.round(s * 1000)), endMs: (ends as number[]).map((s) => Math.round(s * 1000)) };
}

/** Words of the received text with times (bracketed markup skipped). */
export function wordTimings(c: CharacterAlignment): WordTiming[] {
  const out: WordTiming[] = [];
  let word = '';
  let start = 0;
  let end = 0;
  let bracket = 0;
  const flush = () => {
    if (word) out.push({ word, startMs: start, endMs: end });
    word = '';
  };
  c.chars.forEach((ch, i) => {
    if (ch === '[') {
      flush();
      bracket++;
      return;
    }
    if (ch === ']') {
      bracket = Math.max(0, bracket - 1);
      return;
    }
    if (bracket > 0) return;
    if (/\s/.test(ch)) {
      flush();
      return;
    }
    if (!word) start = c.startMs[i]!;
    word += ch;
    end = c.endMs[i]!;
  });
  flush();
  return out;
}
