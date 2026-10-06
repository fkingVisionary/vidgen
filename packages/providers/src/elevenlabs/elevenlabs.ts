import { createHash } from 'node:crypto';
import type { ProviderSettingValues, Rate } from '@docengine/core';
import { audioMetadata, pcmToWav } from '../audio.ts';
import { ProviderError, type CallMeta, type ProviderInfo } from '../types.ts';
import { renderSegments } from '../voice-markup.ts';
import { normalizeVoiceSettings, sentVoiceSettings, settingProblem } from '../voice-settings.ts';
import { ELEVENLABS_MODELS, UNKNOWN_MODEL } from './models.ts';
import { ELEVENLABS_SETTINGS } from './settings.ts';
import type {
  AudioMetadata,
  CharacterAlignment,
  NarrationRequest,
  NarrationResult,
  NarrationSettings,
  PerformanceSegment,
  PronunciationRule,
  RenderedNarration,
  Voice,
  VoiceCheck,
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
 * - Text to speech is billed per character, and the API reports no dollars:
 *   every cost is an ESTIMATE = the characters sent (an upper bound) × the
 *   configured price (ELEVENLABS_USD_PER_1K_CHARS) or the documented list
 *   price for the model. The `character-cost` response header, where
 *   ElevenLabs returns it, is recorded raw beside the estimate and never
 *   priced: its unit is unverified (under eleven_v4 it read about a ninth of
 *   the characters sent).
 * - GET /v1/voices/{voice_id} and GET /v1/models cost nothing: `check()`
 *   uses them to confirm the configured voice and model. GET /v2/voices is
 *   paged (`next_page_token` while `has_more`).
 *
 * A model the table (models.ts) does not know gets plain text (no tags, no
 * SSML) and only stability and similarity, so nothing it would read aloud or
 * reject is ever sent. There is no automatic fallback to another model.
 *
 * Voice settings are the provider settings a request carries, as given
 * (settings.ts describes them), else the flat shorthand from before them. A
 * model is sent only those it takes (`sentSettings`), under ElevenLabs'
 * names; a value that does not fit its description is refused, not sent.
 */

export { ELEVENLABS_MODELS } from './models.ts';

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

interface RequestOptions {
  signal?: AbortSignal;
  /** Per attempt; the provider's timeout when omitted. */
  timeoutMs?: number;
  /** The provider's maxRetries when omitted. */
  retries?: number;
  /** What a 2xx response may already have cost, for an error raised after it arrived (a POST is never sent again). */
  billed?: (headers: Headers, attempts: number) => CallMeta;
}

interface PhonemeRuleBody {
  string_to_replace: string;
  type: 'phoneme';
  phoneme: string;
  alphabet: 'ipa' | 'cmu-arpabet';
}

/** A connectivity check answers quickly or not at all: one attempt each. */
const CHECK_TIMEOUT_MS = 10_000;
/** Paging guards (100 per page). */
const MAX_VOICE_PAGES = 50;
const MAX_DICTIONARY_PAGES = 20;

/** Settings ElevenLabs' API names differently (the rest are sent under their own key). */
const WIRE_NAMES: Readonly<Record<string, string>> = { similarity: 'similarity_boost', speakerBoost: 'use_speaker_boost' };

/** The flat shorthand as provider settings (the keys it has a value for). */
function shorthandSettings(s: NarrationSettings): ProviderSettingValues {
  const out: ProviderSettingValues = {};
  for (const key of ['stability', 'similarity', 'style', 'speakerBoost', 'speed'] as const) if (s[key] !== undefined) out[key] = s[key];
  return out;
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly info: ProviderInfo;
  readonly defaults: { model: string; voiceId: string | null; outputFormat: string };
  readonly settings = ELEVENLABS_SETTINGS;
  readonly models: readonly string[] = Object.keys(ELEVENLABS_MODELS);
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Pronunciation dictionaries found or created in this process, by rule-set hash. */
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

  /** The generic capabilities (which settings a model takes is `sentSettings`'s). */
  capabilities(model: string): VoiceModelCapabilities {
    const { settings: _settings, ...generic } = ELEVENLABS_MODELS[model] ?? UNKNOWN_MODEL;
    return { model, ...generic };
  }

  normalizeSettings(input: Readonly<Record<string, unknown>>): { settings: ProviderSettingValues; problems: string[] } {
    return normalizeVoiceSettings(this.settings, input);
  }

  sentSettings(settings: Readonly<ProviderSettingValues>, model: string): { sent: ProviderSettingValues; ignored: string[] } {
    return sentVoiceSettings(this.settings, settings, model);
  }

  render(segments: readonly PerformanceSegment[], model: string): RenderedNarration {
    return renderSegments(segments, this.capabilities(model));
  }

  /** Every page of the account's voices. */
  async getVoices(): Promise<Voice[]> {
    type Page = { voices?: { voice_id: string; name?: string; description?: string | null; preview_url?: string | null; labels?: Record<string, string> }[]; has_more?: boolean; next_page_token?: string | null };
    const voices = new Map<string, Voice>();
    let token: string | null = null;
    for (let page = 0; page < MAX_VOICE_PAGES; page++) {
      const data: Page = await this.request<Page>('GET', `/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`);
      for (const v of data.voices ?? []) {
        voices.set(v.voice_id, {
          id: v.voice_id,
          name: v.name ?? v.voice_id,
          ...(v.labels?.language ? { language: v.labels.language } : {}),
          ...(v.description ? { description: v.description } : {}),
          ...(v.preview_url ? { previewUrl: v.preview_url } : {}),
        });
      }
      token = data.has_more && data.next_page_token ? data.next_page_token : null;
      if (!token) break;
    }
    return [...voices.values()];
  }

  /** The configured voice and model, looked up without generating anything. Never contains the key. */
  async check(): Promise<VoiceCheck> {
    const { voiceId, model } = this.defaults;
    const quick: RequestOptions = { timeoutMs: CHECK_TIMEOUT_MS, retries: 0 };
    const [voice, models] = await Promise.allSettled([
      voiceId ? this.request<{ name?: unknown }>('GET', `/v1/voices/${encodeURIComponent(voiceId)}`, undefined, quick) : Promise.resolve(null),
      this.request<unknown>('GET', '/v1/models', undefined, quick),
    ]);
    const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^\[elevenlabs\] /, '');
    let voiceName: string | null = null;
    let voicePart: string;
    if (!voiceId) voicePart = 'no voice configured (ELEVENLABS_VOICE_ID)';
    else if (voice.status === 'rejected') voicePart = `voice not confirmed: ${reason(voice.reason)}`;
    else {
      voiceName = typeof voice.value?.name === 'string' && voice.value.name ? voice.value.name : voiceId;
      voicePart = `voice "${voiceName}" found`;
    }
    let modelListed: boolean | null = null;
    let modelPart: string;
    if (models.status === 'rejected') modelPart = `model ${model} not confirmed: ${reason(models.reason)}`;
    else if (!Array.isArray(models.value)) modelPart = `model ${model} not confirmed: the model list was not a list`;
    else {
      modelListed = models.value.some((m: { model_id?: unknown } | null) => m?.model_id === model);
      modelPart = `model ${model} ${modelListed ? 'listed' : 'NOT listed for this key'}`;
    }
    return { ok: voiceName !== null && modelListed !== false, detail: this.redact(`${voicePart}; ${modelPart}`), voiceName, modelListed };
  }

  async generateNarration(req: NarrationRequest): Promise<NarrationResult> {
    const model = req.settings.model;
    const caps = this.capabilities(model);
    if (!req.text.trim()) throw new ProviderError('elevenlabs', 'Narration text is empty', false);
    if (req.text.length > caps.maxCharacters) throw new ProviderError('elevenlabs', `${req.text.length} characters exceed ${model}'s limit of ${caps.maxCharacters} per request`, false);
    if (caps.pauses !== 'BREAKS' && /<break\b/i.test(req.text)) {
      throw new ProviderError('elevenlabs', `${model} takes no SSML: a <break> tag would be read aloud or rejected (pauses are written as ${caps.pauses === 'TAGS' ? '[pause] tags' : 'punctuation'}); not sent`, false);
    }
    const format = req.outputFormat ?? this.opts.outputFormat;
    const { mimeType, container, sampleRate } = parseOutputFormat(format);

    // What the model takes of the request's settings; a setting with no value is not sent.
    const { sent: taken } = this.sentSettings(req.settings.provider ?? shorthandSettings(req.settings), model);
    const unfit = this.settings.flatMap((d) => (d.key in taken ? (settingProblem(d, taken[d.key]) ?? []) : []));
    if (unfit.length) throw new ProviderError('elevenlabs', `Voice settings for ${model} do not fit: ${unfit.join('; ')}; not sent`, false);
    const voiceSettings = Object.fromEntries(Object.entries(taken).map(([key, value]) => [WIRE_NAMES[key] ?? key, value]));
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
    const sent = req.text.length;
    // Usage is the characters sent; ElevenLabs' character-cost header is kept raw beside it, never priced.
    const metaFrom = (headers: Headers, attempts: number, unusable = false): CallMeta => {
      // A plain count only: a blank header is not a report of 0.
      const raw = headers.get('character-cost')?.trim() ?? '';
      const header = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
      const reported = Number.isFinite(header);
      const requestId = headers.get('request-id') ?? headers.get('x-trace-id') ?? undefined;
      const historyItemId = headers.get('history-item-id') ?? undefined;
      const note = `${sent} character${sent === 1 ? '' : 's'} sent (the estimate's basis: an upper bound); ElevenLabs reported ${reported ? `${header} (character-cost header; its unit is unverified, so it is not priced)` : 'no character cost'}`;
      return {
        provider: 'elevenlabs',
        model,
        mock: false,
        usage: [{ unit: 'CHARACTERS', quantity: sent }],
        usageSource: 'COUNTED',
        ...(reported ? { reportedUsage: [{ name: 'character-cost', quantity: header }] } : {}),
        attempts,
        costNote: unusable ? `Response unusable; characters may have been billed. ${note}` : note,
        ...(requestId ? { providerRequestId: requestId } : {}),
        ...(historyItemId ? { providerJobId: historyItemId } : {}),
      };
    };
    const { data, headers, status, attempts } = await this.requestWithHeaders<TimestampsResponse>('POST', path, body, { ...(req.signal ? { signal: req.signal } : {}), billed: (h, n) => metaFrom(h, n, true) });
    // After a 2xx the characters may be billed: these failures keep the usage, so the ledger still costs them.
    const unusable = (message: string, cause?: unknown) => new ProviderError('elevenlabs', message, true, { ...(cause === undefined ? {} : { cause }), status, attempts, meta: metaFrom(headers, attempts, true) });
    if (typeof data.audio_base64 !== 'string' || !data.audio_base64) throw unusable('Response had no audio');
    let audio: Uint8Array = new Uint8Array(Buffer.from(data.audio_base64, 'base64'));
    if (container === 'pcm') audio = pcmToWav(audio, sampleRate);
    let durationMs: number;
    try {
      durationMs = audioMetadata(audio, mimeType).durationMs;
    } catch (err) {
      throw unusable(`Returned audio could not be read as ${format}: ${err instanceof Error ? err.message : String(err)}`, err);
    }
    const characters = parseAlignment(data.alignment);
    const meta = metaFrom(headers, attempts);
    const requestId = meta.providerRequestId;
    return { audio, mimeType, durationMs, alignment: characters ? wordTimings(characters) : null, characters, ...(requestId ? { requestId } : {}), dictionary, meta };
  }

  async getAudioMetadata(audio: Uint8Array, mimeType: string): Promise<AudioMetadata> {
    try {
      return audioMetadata(audio, mimeType);
    } catch (err) {
      throw new ProviderError('elevenlabs', err instanceof Error ? err.message : String(err), false);
    }
  }

  /**
   * A pronunciation dictionary holding exactly these phoneme rules: the one
   * an earlier process made (found by its name, which hashes the rules, and
   * compared rule by rule), else a new one. Looked up once per rule set and
   * process.
   */
  private dictionaryFor(rules: readonly PronunciationRule[]): Promise<{ id: string; version: string }> {
    const sorted = [...rules].sort((a, b) => a.term.localeCompare(b.term));
    const hash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
    let pending = this.dictionaries.get(hash);
    if (!pending) {
      const name = `docengine-${hash}`;
      const body: PhonemeRuleBody[] = sorted.map((r) => ({
        string_to_replace: r.term,
        type: 'phoneme',
        phoneme: r.method === 'IPA' ? `/${r.pronunciation.replace(/^\/|\/$/g, '')}/` : r.pronunciation,
        alphabet: r.method === 'IPA' ? 'ipa' : 'cmu-arpabet',
      }));
      pending = this.findDictionary(name, body).then(
        (found) =>
          found ??
          this.request<{ id?: string; version_id?: string }>('POST', '/v1/pronunciation-dictionaries/add-from-rules', {
            name,
            description: 'Pronunciations approved in the Documentary Engine review list',
            rules: body,
          }).then((d) => {
            if (!d.id || !d.version_id) throw new ProviderError('elevenlabs', 'Pronunciation dictionary response had no id or version', false);
            return { id: d.id, version: d.version_id };
          }),
      );
      pending.catch(() => this.dictionaries.delete(hash));
      this.dictionaries.set(hash, pending);
    }
    return pending;
  }

  /** The latest version of an unarchived dictionary of this name holding exactly these rules; null when there is none or the list cannot be read. */
  private async findDictionary(name: string, rules: readonly PhonemeRuleBody[]): Promise<{ id: string; version: string } | null> {
    type Listed = { id?: string; name?: string; latest_version_id?: string; latest_version_rules_num?: number; archived_time_unix?: number | null };
    type Page = { pronunciation_dictionaries?: Listed[]; has_more?: boolean; next_cursor?: string | null };
    try {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_DICTIONARY_PAGES; page++) {
        const data: Page = await this.request<Page>('GET', `/v1/pronunciation-dictionaries?page_size=100&include_archived=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        for (const d of data.pronunciation_dictionaries ?? []) {
          if (d.name !== name || !d.id || !d.latest_version_id || d.archived_time_unix || d.latest_version_rules_num !== rules.length) continue;
          const full = await this.request<{ latest_version_id?: string; rules?: unknown }>('GET', `/v1/pronunciation-dictionaries/${encodeURIComponent(d.id)}`);
          if (full.latest_version_id === d.latest_version_id && sameRules(full.rules, rules)) return { id: d.id, version: d.latest_version_id };
        }
        cursor = data.has_more && data.next_cursor ? data.next_cursor : null;
        if (!cursor) break;
      }
    } catch {
      // Not readable (e.g. a key that may only create dictionaries): a new dictionary is made instead.
    }
    return null;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, body, opts)).data;
  }

  private async requestWithHeaders<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: RequestOptions = {}): Promise<{ data: T; headers: Headers; status: number; attempts: number }> {
    const op = path.split('?')[0]!.replace(/\/[A-Za-z0-9]{16,}(?=\/|$)/g, '/{id}');
    const { signal } = opts;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const retries = opts.retries ?? this.maxRetries;
    for (let attempt = 0; ; attempt++) {
      const attempts = attempt + 1;
      let res: Response | undefined;
      let text: string;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: { 'xi-api-key': this.opts.apiKey!, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        // A timeout or reset while the body streams in fails the attempt too.
        text = await res.text();
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        const why = timedOut ? `timed out after ${timeoutMs} ms` : `failed: ${err instanceof Error ? err.message : String(err)}`;
        const served = res?.ok ? opts.billed?.(res.headers, attempts) : undefined;
        const details = { cause: err, attempts, ...(res ? { status: res.status } : {}), ...(served ? { meta: served } : {}) };
        if (signal?.aborted) throw new ProviderError('elevenlabs', `${op}: cancelled`, false, details);
        if (res) {
          const retryable = res.ok || res.status === 429 || res.status >= 500;
          const failure = new ProviderError('elevenlabs', `${op}: HTTP ${res.status}, then reading the response ${why}`, retryable, details);
          // A POST that was served is not sent again here (text to speech is billed; a dictionary would be made twice); a GET is.
          if ((res.ok && method !== 'GET') || !retryable || attempt >= retries) throw failure;
        } else if (attempt >= retries) throw new ProviderError('elevenlabs', `${op}: ${timedOut ? why : `request ${why}`}`, true, details);
        await this.sleep(backoff(attempt));
        continue;
      }
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const error = new ProviderError('elevenlabs', `${op}: HTTP ${res.status}: ${errorDetail(text)}`, retryable, { status: res.status, attempts });
        if (retryable && attempt < retries) {
          const after = Number(res.headers.get('retry-after'));
          await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : backoff(attempt));
          continue;
        }
        throw error;
      }
      try {
        return { data: JSON.parse(text) as T, headers: res.headers, status: res.status, attempts };
      } catch (err) {
        const served = opts.billed?.(res.headers, attempts);
        throw new ProviderError('elevenlabs', `${op}: response was not valid JSON`, true, { cause: err, status: res.status, attempts, ...(served ? { meta: served } : {}) });
      }
    }
  }

  /** The key never appears in what a check reports. */
  private redact(text: string): string {
    return this.opts.apiKey ? text.split(this.opts.apiKey).join('[redacted]') : text;
  }
}

const ruleKey = (r: Partial<Record<'string_to_replace' | 'type' | 'phoneme' | 'alphabet' | 'case_sensitive' | 'word_boundaries', unknown>>) =>
  JSON.stringify([r.string_to_replace, r.type, r.phoneme, r.alphabet, r.case_sensitive ?? true, r.word_boundaries ?? true]);

/** Whether a dictionary's rules are exactly these (any order; ElevenLabs' defaults for case and word boundaries). */
function sameRules(found: unknown, wanted: readonly PhonemeRuleBody[]): boolean {
  if (!Array.isArray(found) || found.length !== wanted.length) return false;
  const a = found.map((r: unknown) => (r && typeof r === 'object' ? ruleKey(r) : '')).sort();
  const b = wanted.map(ruleKey).sort();
  return a.every((k, i) => k === b[i]);
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
