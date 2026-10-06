import { estimateCost } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../types.ts';
import type { NarrationRequest } from '../voice.ts';
import { ElevenLabsVoiceProvider, type ElevenLabsOptions } from './elevenlabs.ts';

/**
 * The ElevenLabs provider against a fake endpoint: no API key, no network,
 * no credits. Response shapes follow the API reference (convert with
 * timestamps, pronunciation dictionaries, error bodies).
 */

/** `n` frames of MPEG-1 layer III, 128 kbps, 44.1 kHz, mono (26.12 ms each). */
export function fakeMp3(frames: number): Uint8Array {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0xc4]);
  const out = new Uint8Array(417 * frames);
  for (let i = 0; i < frames; i++) out.set(frame, i * 417);
  return out;
}

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

function fake(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input), headers: new Headers(init?.headers), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const fail = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const ALIGNMENT = (text: string) => ({
  characters: [...text],
  character_start_times_seconds: [...text].map((_, i) => i * 0.05),
  character_end_times_seconds: [...text].map((_, i) => (i + 1) * 0.05),
});

function provider(responses: (Response | Error)[], extra: Partial<ElevenLabsOptions> = {}) {
  const f = fake(responses);
  const sleeps: number[] = [];
  const p = new ElevenLabsVoiceProvider({ apiKey: 'test-key', model: 'eleven_v4', outputFormat: 'mp3_44100_128', fetch: f.fetchImpl, sleep: async (ms) => void sleeps.push(ms), ...extra });
  return { p, calls: f.calls, sleeps };
}

const request = (text: string, extra: Partial<NarrationRequest> = {}): NarrationRequest => ({
  text,
  language: 'en',
  settings: { voiceId: 'voice-abc', model: 'eleven_v4', stability: 0.5, similarity: 0.75, style: 0.3, speed: 0.94, speakerBoost: true },
  withTimestamps: true,
  ...extra,
});

describe('ElevenLabs v4 requests', () => {
  it('sends one chunk to the timestamps endpoint with v4 settings only, context, seed and language, and measures the audio it gets back', async () => {
    const text = '[reflective, intimate] It is a promise.';
    const audio = fakeMp3(100);
    const { p, calls } = provider([ok({ audio_base64: Buffer.from(audio).toString('base64'), alignment: ALIGNMENT(text), normalized_alignment: null }, { 'request-id': 'req-123', 'character-cost': '39' })]);
    const r = await p.generateNarration(request(text, { previousText: 'Nobody has seen it.', nextText: 'And it grows.', seed: 42 }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-abc/with-timestamps?output_format=mp3_44100_128');
    expect(calls[0]!.headers.get('xi-api-key')).toBe('test-key');
    expect(calls[0]!.body).toEqual({
      text,
      model_id: 'eleven_v4',
      // Eleven v4 takes stability and similarity only: style, speed and speaker boost are not sent.
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      language_code: 'en',
      seed: 42,
      previous_text: 'Nobody has seen it.',
      next_text: 'And it grows.',
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain('test-key');

    expect(r.mimeType).toBe('audio/mpeg');
    expect(r.durationMs).toBe(2612); // 100 frames × 1152 samples at 44.1 kHz, measured from the file
    expect(r.requestId).toBe('req-123');
    expect(r.characters!.chars.join('')).toBe(text);
    expect(r.characters!.startMs.slice(0, 3)).toEqual([0, 50, 100]);
    // Word timings skip the bracketed direction.
    expect(r.alignment!.map((w) => w.word)).toEqual(['It', 'is', 'a', 'promise.']);
    expect(r.meta).toEqual({ provider: 'elevenlabs', model: 'eleven_v4', mock: false, usage: [{ unit: 'CHARACTERS', quantity: 39 }], usageSource: 'REPORTED', attempts: 1, costNote: '39 character(s) reported by ElevenLabs (character-cost)', providerRequestId: 'req-123' });
  });

  it('prices reported characters at the documented list price (an estimate: the API reports characters, not dollars), or at a configured rate', () => {
    const { p } = provider([]);
    expect(estimateCost('elevenlabs', 'eleven_v4', [{ unit: 'CHARACTERS', quantity: 1000 }], p.info.rates)).toEqual({ costUsd: 0.08, unpriced: [] });
    expect(estimateCost('elevenlabs', 'some_future_model', [{ unit: 'CHARACTERS', quantity: 1000 }], p.info.rates).unpriced).toEqual([{ unit: 'CHARACTERS', quantity: 1000 }]);
    const { p: plan } = provider([], { usdPer1kChars: 0.022 });
    expect(estimateCost('elevenlabs', 'eleven_v4', [{ unit: 'CHARACTERS', quantity: 2000 }], plan.info.rates).costUsd).toBe(0.044);
  });

  it('counts the characters it sent when ElevenLabs reports no character cost, and says so', async () => {
    const { p } = provider([ok({ audio_base64: Buffer.from(fakeMp3(10)).toString('base64'), alignment: null })]);
    const r = await p.generateNarration(request('Short line.'));
    expect(r.meta.usage).toEqual([{ unit: 'CHARACTERS', quantity: 11 }]);
    expect(r.meta.usageSource).toBe('COUNTED');
    expect(r.meta.costNote).toBe('ElevenLabs reported no character cost: 11 character(s) counted as sent');
    // Missing alignment is not an error here: the take records it, voice QA flags it.
    expect(r.characters).toBeNull();
    expect(r.alignment).toBeNull();
  });

  it('stitches to earlier takes by request id (which replaces the text context), at most three', async () => {
    const { p, calls } = provider([ok({ audio_base64: Buffer.from(fakeMp3(5)).toString('base64'), alignment: null })]);
    await p.generateNarration(request('Then the market turned.', { previousText: 'ignored', previousRequestIds: ['r1', 'r2', 'r3', 'r4'] }));
    expect(calls[0]!.body).toMatchObject({ previous_request_ids: ['r2', 'r3', 'r4'] });
    expect(calls[0]!.body).not.toHaveProperty('previous_text');
  });

  it('builds a pronunciation dictionary of approved phoneme rules once, and points each take at its version', async () => {
    const take = () => ok({ audio_base64: Buffer.from(fakeMp3(5)).toString('base64'), alignment: null });
    // None made by an earlier process yet: the list is empty, so one is created.
    const { p, calls } = provider([ok({ pronunciation_dictionaries: [], has_more: false }), ok({ id: 'dict-1', version_id: 'ver-1', name: 'x' }), take(), take()]);
    const rules = [{ term: 'Haarlem', method: 'IPA' as const, pronunciation: 'ˈɦaːrlɛm' }];
    const r = await p.generateNarration(request('In Haarlem.', { pronunciations: rules }));
    await p.generateNarration(request('Back in Haarlem.', { pronunciations: rules }));
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.elevenlabs.io', '')}`)).toEqual([
      'GET /v1/pronunciation-dictionaries?page_size=100&include_archived=false',
      'POST /v1/pronunciation-dictionaries/add-from-rules',
      'POST /v1/text-to-speech/voice-abc/with-timestamps?output_format=mp3_44100_128',
      'POST /v1/text-to-speech/voice-abc/with-timestamps?output_format=mp3_44100_128',
    ]);
    expect(calls[1]!.body).toMatchObject({ rules: [{ string_to_replace: 'Haarlem', type: 'phoneme', phoneme: '/ˈɦaːrlɛm/', alphabet: 'ipa' }] });
    expect(calls[2]!.body).toMatchObject({ pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: 'dict-1', version_id: 'ver-1' }] });
    expect(r.dictionary).toEqual({ id: 'dict-1', version: 'ver-1' });
  });
});

describe('ElevenLabs models', () => {
  it('renders v4 directions as audio tags and pauses as [pause], never SSML', () => {
    const { p } = provider([]);
    const r = p.render(
      [
        { text: 'Nobody at this table has seen what he is buying.', intent: null, pauseAfter: 'MEDIUM' },
        { text: 'What changes hands is not a flower.', intent: { emotion: 'curious', delivery: null, intensity: 'LOW', pacing: 'NORMAL', vocalAction: null }, pauseAfter: 'NONE' },
        { text: "It's a promise.", intent: { emotion: null, delivery: 'quiet, deliberate'.split(', ')[0]!, intensity: 'LOW', pacing: 'SLOW', vocalAction: null }, pauseAfter: 'NONE' },
      ],
      'eleven_v4',
    );
    expect(r.text).toBe("Nobody at this table has seen what he is buying. [pause] [curious] What changes hands is not a flower. [quiet] It's a promise.");
    expect(r.text).not.toContain('<break');
    expect(r.markup.map((m) => r.text.slice(m.start, m.end))).toEqual(['[pause]', '[curious]', '[quiet]']);
    expect(r.segments.map((s) => r.text.slice(s.start, s.end))).toEqual(['Nobody at this table has seen what he is buying.', 'What changes hands is not a flower.', "It's a promise."]);
  });

  it('sends a multilingual v2 model SSML breaks, speed and style, and reports directions it cannot take', async () => {
    const { p, calls } = provider([ok({ audio_base64: Buffer.from(fakeMp3(5)).toString('base64'), alignment: null })]);
    const r = p.render([{ text: 'It begins.', intent: { emotion: 'tense', delivery: null, intensity: 'MEDIUM', pacing: 'NORMAL', vocalAction: null }, pauseAfter: 'LONG' }, { text: 'Then it ends.', intent: null, pauseAfter: 'NONE' }], 'eleven_multilingual_v2');
    expect(r.text).toBe('It begins. <break time="2.0s" /> Then it ends.');
    expect(r.unsupported).toEqual(['sentence 1: direction "tense" (the model takes no directions)']);
    await p.generateNarration(request(r.text, { settings: { ...request('').settings, model: 'eleven_multilingual_v2' } }));
    expect(calls[0]!.body).toMatchObject({ model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true, speed: 0.94 } });
    expect(calls[0]!.body).not.toHaveProperty('language_code');
  });

  it('gives a model it does not know plain text and conservative settings (no automatic fallback)', async () => {
    const { p, calls } = provider([ok({ audio_base64: Buffer.from(fakeMp3(5)).toString('base64'), alignment: null })]);
    expect(p.capabilities('eleven_v9')).toMatchObject({ known: false, directions: false, pauses: 'PUNCTUATION', contextText: false });
    expect(p.render([{ text: 'A.', intent: { emotion: 'tense', delivery: null, intensity: 'LOW', pacing: 'NORMAL', vocalAction: null }, pauseAfter: 'MEDIUM' }, { text: 'B.', intent: null, pauseAfter: 'NONE' }], 'eleven_v9').text).toBe('A.\nB.');
    await p.generateNarration(request('A.', { settings: { ...request('').settings, model: 'eleven_v9' }, previousText: 'x' }));
    expect(calls[0]!.body).toEqual({ text: 'A.', model_id: 'eleven_v9', voice_settings: { stability: 0.5, similarity_boost: 0.75 } });
  });
});

describe('ElevenLabs failures', () => {
  it('does not retry a rejected key, and reports the code and message', async () => {
    const { p, calls } = provider([fail(401, { detail: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key', request_id: 'x' } })]);
    const err = await p.generateNarration(request('Hello.')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as ProviderError).message).toBe('[elevenlabs] /v1/text-to-speech/voice-abc/with-timestamps: HTTP 401: invalid_api_key: Invalid API key');
    // The status is a field, so callers need not parse the message.
    expect(err).toMatchObject({ status: 401, attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it('retries a rate limit (honouring Retry-After) and a server error, then gives up', async () => {
    const audio = Buffer.from(fakeMp3(5)).toString('base64');
    const busy = new Response(JSON.stringify({ detail: { code: 'concurrent_limit_exceeded', message: 'Too many concurrent requests' } }), { status: 429, headers: { 'retry-after': '2' } });
    const { p, sleeps } = provider([busy, ok({ audio_base64: audio, alignment: null })]);
    // The ledger sees the retry: two attempts for one call.
    await expect(p.generateNarration(request('Hello.'))).resolves.toMatchObject({ mimeType: 'audio/mpeg', meta: { attempts: 2 } });
    expect(sleeps).toEqual([2000]);

    const down = () => fail(503, { detail: { code: 'service_unavailable', message: 'down' } });
    const { p: p2, calls } = provider([down(), down(), down()]);
    const err = (await p2.generateNarration(request('Hello.')).catch((e: unknown) => e)) as ProviderError;
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/HTTP 503: service_unavailable: down/);
    expect(err).toMatchObject({ status: 503, attempts: 3 });
    // Nothing was served, so nothing is costed.
    expect(err.meta).toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  it('turns a timeout into a retryable error after its retries', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { p, calls } = provider([timeout, timeout, timeout], { timeoutMs: 5 });
    const err = (await p.generateNarration(request('Hello.')).catch((e: unknown) => e)) as ProviderError;
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('[elevenlabs] /v1/text-to-speech/voice-abc/with-timestamps: timed out after 5 ms');
    expect(calls).toHaveLength(3);
  });

  it('rejects malformed responses: invalid JSON, no audio, audio that is not what was asked for', async () => {
    const bad = (body: string) => new Response(body, { status: 200 });
    const { p } = provider([bad('<html>oops</html>')], { maxRetries: 0 });
    await expect(p.generateNarration(request('Hello.'))).rejects.toThrow(/response was not valid JSON/);
    const { p: p2 } = provider([ok({ alignment: null })]);
    await expect(p2.generateNarration(request('Hello.'))).rejects.toThrow(/Response had no audio/);
    const { p: p3 } = provider([ok({ audio_base64: Buffer.from('not audio at all').toString('base64'), alignment: null })]);
    await expect(p3.generateNarration(request('Hello.'))).rejects.toThrow(/Returned audio could not be read as mp3_44100_128: No MPEG audio frames found/);

    // Each came after a 2xx, so the characters may have been billed: the error keeps the usage for the ledger.
    const served = [
      provider([bad('<html>oops</html>')]),
      provider([ok({ alignment: null }, { 'character-cost': '6', 'request-id': 'req-9' })]),
      provider([ok({ audio_base64: Buffer.from('not audio at all').toString('base64'), alignment: null })]),
    ];
    const errors = await Promise.all(served.map(async ({ p: x }) => (await x.generateNarration(request('Hello.')).catch((e: unknown) => e)) as ProviderError));
    expect(errors.map((e) => [e.retryable, e.status, e.attempts, e.meta?.usage, e.meta?.usageSource])).toEqual([
      [true, 200, 1, [{ unit: 'CHARACTERS', quantity: 6 }], 'COUNTED'],
      [true, 200, 1, [{ unit: 'CHARACTERS', quantity: 6 }], 'REPORTED'],
      [true, 200, 1, [{ unit: 'CHARACTERS', quantity: 6 }], 'COUNTED'],
    ]);
    expect(errors[1]!.meta).toMatchObject({ provider: 'elevenlabs', model: 'eleven_v4', mock: false, providerRequestId: 'req-9', costNote: 'Response unusable; characters may have been billed. 6 character(s) reported by ElevenLabs (character-cost)' });
    // Never sent twice: a served request is not retried.
    expect(served.map((x) => x.calls.length)).toEqual([1, 1, 1]);
    // A malformed alignment is dropped, not trusted.
    const { p: p4 } = provider([ok({ audio_base64: Buffer.from(fakeMp3(5)).toString('base64'), alignment: { characters: ['a', 'b'], character_start_times_seconds: [0], character_end_times_seconds: [0.1, 0.2] } })]);
    expect((await p4.generateNarration(request('ab'))).characters).toBeNull();
  });

  it('refuses before calling: no key, too many characters, an output format it cannot measure', async () => {
    expect(() => new ElevenLabsVoiceProvider({ model: 'eleven_v4', outputFormat: 'mp3_44100_128' })).toThrow(/ELEVENLABS_API_KEY is not set/);
    expect(() => new ElevenLabsVoiceProvider({ apiKey: 'k', model: 'eleven_v4', outputFormat: 'opus_48000_64' })).toThrow(/opus and µ-law cannot be measured or joined/);
    const { p, calls } = provider([]);
    await expect(p.generateNarration(request('x'.repeat(10_001)))).rejects.toThrow(/10001 characters exceed eleven_v4's limit of 10000/);
    expect(calls).toHaveLength(0);
  });
});

/** A response whose headers arrive and whose body then breaks off with `err`. */
const brokenBody = (status: number, err: Error, onRead?: () => void) =>
  new Response(
    new ReadableStream({
      pull(c) {
        onRead?.();
        c.error(err);
      },
    }),
    { status },
  );

const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('ElevenLabs response bodies', () => {
  it('retries a server error whose body breaks off, like any failed attempt', async () => {
    const { p, calls, sleeps } = provider([brokenBody(503, new TypeError('terminated')), ok({ audio_base64: Buffer.from(fakeMp3(5)).toString('base64'), alignment: null })]);
    const r = await p.generateNarration(request('Hello.'));
    expect(r.meta.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it('turns a 2xx whose body times out into a ProviderError that keeps the usage, and never sends it again', async () => {
    const { p, calls } = provider([brokenBody(200, timeoutError())]);
    const err = (await p.generateNarration(request('Short line.')).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe('[elevenlabs] /v1/text-to-speech/voice-abc/with-timestamps: HTTP 200, then reading the response timed out after 120000 ms');
    expect(err).toMatchObject({ retryable: true, status: 200, attempts: 1 });
    expect(err.meta).toMatchObject({ usage: [{ unit: 'CHARACTERS', quantity: 11 }], usageSource: 'COUNTED', costNote: 'Response unusable; characters may have been billed. ElevenLabs reported no character cost: 11 character(s) counted as sent' });
    expect(calls).toHaveLength(1);
  });

  it('reports a cancelled job as cancelled, not as a timeout, when the body breaks off after the abort', async () => {
    const job = new AbortController();
    const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const { p, calls } = provider([brokenBody(200, aborted, () => job.abort())]);
    const err = (await p.generateNarration(request('Short line.', { signal: job.signal })).catch((e: unknown) => e)) as ProviderError;
    expect(err.message).toBe('[elevenlabs] /v1/text-to-speech/voice-abc/with-timestamps: cancelled');
    expect(err.retryable).toBe(false);
    expect(err.meta?.usage).toEqual([{ unit: 'CHARACTERS', quantity: 11 }]);
    expect(calls).toHaveLength(1);
  });

  it('sends a lookup again when its 2xx body breaks off (a GET is free and safe to repeat), but never a POST', async () => {
    const voices = ok({ voices: [{ voice_id: 'a', name: 'A' }], has_more: false });
    const { p, calls, sleeps } = provider([brokenBody(200, new TypeError('terminated')), voices]);
    expect((await p.getVoices()).map((v) => v.id)).toEqual(['a']);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(sleeps).toEqual([1000]);

    // Creating a dictionary is not repeated: a second POST would make a second dictionary.
    const rules = [{ term: 'Haarlem', method: 'IPA' as const, pronunciation: 'ˈɦaːrlɛm' }];
    const { p: p2, calls: calls2 } = provider([ok({ pronunciation_dictionaries: [], has_more: false }), brokenBody(200, new TypeError('terminated'))]);
    const err = (await p2.generateNarration(request('In Haarlem.', { pronunciations: rules })).catch((e: unknown) => e)) as ProviderError;
    expect(err).toMatchObject({ retryable: true, status: 200, attempts: 1 });
    expect(err.meta).toBeUndefined();
    expect(calls2.map((c) => `${c.method} ${c.url.replace('https://api.elevenlabs.io', '')}`)).toEqual(['GET /v1/pronunciation-dictionaries?page_size=100&include_archived=false', 'POST /v1/pronunciation-dictionaries/add-from-rules']);
  });

  it('does not retry a rejected request whose body breaks off', async () => {
    const { p, calls } = provider([brokenBody(401, new TypeError('terminated'))]);
    const err = (await p.generateNarration(request('Hello.')).catch((e: unknown) => e)) as ProviderError;
    expect(err).toMatchObject({ retryable: false, status: 401, attempts: 1 });
    expect(err.meta).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('ElevenLabs SSML guard', () => {
  it('refuses a <break> for a tag model and a model it does not know, before anything is sent', async () => {
    const { p, calls } = provider([]);
    const v4 = (await p.generateNarration(request('Wait. <break time="1.0s" /> Then go.')).catch((e: unknown) => e)) as ProviderError;
    expect(v4).toBeInstanceOf(ProviderError);
    expect(v4.retryable).toBe(false);
    expect(v4.message).toBe('[elevenlabs] eleven_v4 takes no SSML: a <break> tag would be read aloud or rejected (pauses are written as [pause] tags); not sent');
    await expect(p.generateNarration(request('Wait. <BREAK/> Then go.', { settings: { ...request('').settings, model: 'eleven_v9' } }))).rejects.toThrow(/eleven_v9 takes no SSML.*written as punctuation/);
    expect(calls).toHaveLength(0);
  });
});

type Route = (call: Call, url: URL) => Response | Error;

/** A fake ElevenLabs that answers by method and path. */
function serve(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = { method: init?.method ?? 'GET', url: String(input), headers: new Headers(init?.headers), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
    calls.push(call);
    const url = new URL(call.url);
    const route = routes[`${call.method} ${url.pathname}`];
    if (!route) throw new Error(`no fake route for ${call.method} ${url.pathname}`);
    const res = route(call, url);
    if (res instanceof Error) throw res;
    return res;
  };
  return { calls, fetchImpl };
}

function providerOn(routes: Record<string, Route>, extra: Partial<ElevenLabsOptions> = {}) {
  const f = serve(routes);
  const sleeps: number[] = [];
  const p = new ElevenLabsVoiceProvider({ apiKey: 'test-key-secret', model: 'eleven_v4', voiceId: 'voice-abc', outputFormat: 'mp3_44100_128', fetch: f.fetchImpl, sleep: async (ms) => void sleeps.push(ms), ...extra });
  return { p, calls: f.calls, sleeps };
}

const MODELS = [{ model_id: 'eleven_multilingual_v2' }, { model_id: 'eleven_v4' }];

describe('ElevenLabs voices and connectivity', () => {
  it('reads every page of voices', async () => {
    const page = (ids: string[], next: string | null) => ok({ voices: ids.map((id) => ({ voice_id: id, name: `Voice ${id}` })), has_more: next !== null, total_count: 3, next_page_token: next });
    const { p, calls } = providerOn({ 'GET /v2/voices': (_c, url) => (url.searchParams.get('next_page_token') === 'p2' ? page(['c'], null) : page(['a', 'b'], 'p2')) });
    expect((await p.getVoices()).map((v) => v.id)).toEqual(['a', 'b', 'c']);
    expect(calls.map((c) => c.url.replace('https://api.elevenlabs.io', ''))).toEqual(['/v2/voices?page_size=100', '/v2/voices?page_size=100&next_page_token=p2']);
  });

  it('checks the configured voice and model with the free lookups only, once each, without the key in what it reports', async () => {
    const { p, calls, sleeps } = providerOn({
      'GET /v1/voices/voice-abc': () => ok({ voice_id: 'voice-abc', name: 'Documentary Narrator' }),
      'GET /v1/models': () => ok(MODELS),
    });
    const check = await p.check();
    expect(check).toEqual({ ok: true, detail: 'voice "Documentary Narrator" found; model eleven_v4 listed', voiceName: 'Documentary Narrator', modelListed: true });
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.elevenlabs.io', '')}`).sort()).toEqual(['GET /v1/models', 'GET /v1/voices/voice-abc']);
    expect(calls.every((c) => c.headers.get('xi-api-key') === 'test-key-secret')).toBe(true);
    expect(JSON.stringify(check)).not.toContain('test-key-secret');
    expect(sleeps).toEqual([]);
  });

  it('says what is wrong: an unknown voice, an unlisted model, a rejected key, no voice configured', async () => {
    const notFound = await providerOn({
      'GET /v1/voices/voice-abc': () => fail(404, { detail: { status: 'voice_not_found', message: 'A voice with the voice_id voice-abc was not found.' } }),
      'GET /v1/models': () => ok(MODELS),
    }).p.check();
    expect(notFound).toEqual({ ok: false, detail: 'voice not confirmed: /v1/voices/voice-abc: HTTP 404: voice_not_found: A voice with the voice_id voice-abc was not found.; model eleven_v4 listed', voiceName: null, modelListed: true });

    const unlisted = await providerOn({ 'GET /v1/voices/voice-abc': () => ok({ name: 'N' }), 'GET /v1/models': () => ok([{ model_id: 'eleven_multilingual_v2' }]) }, { model: 'eleven_v4' }).p.check();
    expect(unlisted).toMatchObject({ ok: false, modelListed: false, detail: 'voice "N" found; model eleven_v4 NOT listed for this key' });

    // A key without permission to read models: the model cannot be confirmed, which is said, but the voice is there.
    const { p: noModels, calls } = providerOn({ 'GET /v1/voices/voice-abc': () => ok({ name: 'N' }), 'GET /v1/models': () => fail(503, { detail: 'busy' }) });
    expect(await noModels.check()).toMatchObject({ ok: true, modelListed: null, detail: 'voice "N" found; model eleven_v4 not confirmed: /v1/models: HTTP 503: busy' });
    expect(calls).toHaveLength(2); // a check is not retried

    // An error body that echoes the key never carries it into the report.
    const rejected = await providerOn({ 'GET /v1/voices/voice-abc': () => fail(401, { detail: 'invalid key test-key-secret' }), 'GET /v1/models': () => fail(401, { detail: 'invalid key test-key-secret' }) }).p.check();
    expect(rejected.ok).toBe(false);
    expect(rejected.detail).toBe('voice not confirmed: /v1/voices/voice-abc: HTTP 401: invalid key [redacted]; model eleven_v4 not confirmed: /v1/models: HTTP 401: invalid key [redacted]');

    const { p: unset, calls: unsetCalls } = providerOn({ 'GET /v1/models': () => ok(MODELS) }, { voiceId: null });
    expect(await unset.check()).toEqual({ ok: false, detail: 'no voice configured (ELEVENLABS_VOICE_ID); model eleven_v4 listed', voiceName: null, modelListed: true });
    expect(unsetCalls).toHaveLength(1);
  });
});

describe('ElevenLabs pronunciation dictionaries across processes', () => {
  const rules = [{ term: 'Haarlem', method: 'IPA' as const, pronunciation: 'ˈɦaːrlɛm' }];
  const take = () => ok({ audio_base64: Buffer.from(fakeMp3(5)).toString('base64'), alignment: null });

  it('reuses the dictionary an earlier process made for exactly these rules, and makes a new one otherwise', async () => {
    // Process 1: nothing to reuse, so it creates one; its name identifies the rule set.
    const first = providerOn({
      'GET /v1/pronunciation-dictionaries': () => ok({ pronunciation_dictionaries: [], has_more: false }),
      'POST /v1/pronunciation-dictionaries/add-from-rules': () => ok({ id: 'dict-1', version_id: 'ver-1' }),
      'POST /v1/text-to-speech/voice-abc/with-timestamps': take,
    });
    await first.p.generateNarration(request('In Haarlem.', { pronunciations: rules }));
    const created = first.calls.find((c) => c.url.endsWith('/add-from-rules'))!.body as { name: string; rules: unknown[] };
    expect(created.name).toMatch(/^docengine-[0-9a-f]{16}$/);

    // Process 2 (after a restart): the same rules find that dictionary; nothing is created.
    const listed = (overrides: Record<string, unknown> = {}) => ({ id: 'dict-1', name: created.name, latest_version_id: 'ver-1', latest_version_rules_num: 1, archived_time_unix: null, ...overrides });
    const later = (entry: Record<string, unknown>, rulesNow: unknown[]) =>
      providerOn({
        'GET /v1/pronunciation-dictionaries': () => ok({ pronunciation_dictionaries: [{ id: 'other', name: 'someone-else', latest_version_id: 'v', latest_version_rules_num: 1 }, entry], has_more: false }),
        'GET /v1/pronunciation-dictionaries/dict-1': () => ok({ id: 'dict-1', latest_version_id: entry.latest_version_id, rules: rulesNow }),
        'POST /v1/pronunciation-dictionaries/add-from-rules': () => ok({ id: 'dict-2', version_id: 'ver-2' }),
        'POST /v1/text-to-speech/voice-abc/with-timestamps': take,
      });
    const second = later(listed(), [{ ...(created.rules[0] as object), case_sensitive: true, word_boundaries: true }]);
    const r = await second.p.generateNarration(request('Back in Haarlem.', { pronunciations: rules }));
    expect(r.dictionary).toEqual({ id: 'dict-1', version: 'ver-1' });
    expect(second.calls.some((c) => c.url.endsWith('/add-from-rules'))).toBe(false);
    expect(second.calls.at(-1)!.body).toMatchObject({ pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: 'dict-1', version_id: 'ver-1' }] });

    // Edited since (other rules), or archived: a new dictionary is made instead.
    const edited = later(listed(), [{ ...(created.rules[0] as object), phoneme: '/ˈhɑrləm/' }]);
    expect((await edited.p.generateNarration(request('In Haarlem.', { pronunciations: rules }))).dictionary).toEqual({ id: 'dict-2', version: 'ver-2' });
    const archived = later(listed({ archived_time_unix: 1_700_000_000 }), created.rules);
    expect((await archived.p.generateNarration(request('In Haarlem.', { pronunciations: rules }))).dictionary).toEqual({ id: 'dict-2', version: 'ver-2' });
  });

  it('makes a new dictionary when the list cannot be read', async () => {
    const { p, calls } = providerOn({
      'GET /v1/pronunciation-dictionaries': () => fail(401, { detail: { status: 'missing_permissions', message: 'The API key is missing the permission pronunciation_dictionaries_read' } }),
      'POST /v1/pronunciation-dictionaries/add-from-rules': () => ok({ id: 'dict-3', version_id: 'ver-3' }),
      'POST /v1/text-to-speech/voice-abc/with-timestamps': take,
    });
    expect((await p.generateNarration(request('In Haarlem.', { pronunciations: rules }))).dictionary).toEqual({ id: 'dict-3', version: 'ver-3' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
  });
});
