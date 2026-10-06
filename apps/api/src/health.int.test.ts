import type { HealthView } from '@docengine/core';
import { ALL_MOCK, ElevenLabsVoiceProvider, MockVoiceProvider, S3StorageProvider, createProviders, type ProviderSet, type VoiceProvider } from '@docengine/providers';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../../test/helpers.ts';
import { buildApp } from './app.ts';
import { CONNECTIVITY_TIMEOUT_MS, createContainer, startConnectivityCheck, type AppContainer } from './container.ts';
import { parseEnv } from './env.ts';

/**
 * /api/health's connectivity: real storage and the real voice provider are
 * checked once at startup (fake endpoints here: no key, no network, nothing
 * spent), the result is cached and logged once, and no secret ever shows.
 */

const db = useTestDatabase();
let open: { app: FastifyInstance; c: AppContainer }[] = [];

const S3_SECRET = 'fake-s3-secret-value';
const VOICE_KEY = 'fake-elevenlabs-key';

/** A fake S3 bucket that records each request; `refuse` answers a method with an S3 error that echoes the secret. */
function fakeS3(refuse: Record<string, number> = {}) {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const key = decodeURIComponent(new URL(String(input)).pathname.slice(1));
    calls.push(method);
    if (refuse[method]) return new Response(`<Error><Code>AccessDenied</Code><Message>Denied for ${S3_SECRET}</Message></Error>`, { status: refuse[method] });
    if (method === 'PUT') objects.set(key, new Uint8Array(init!.body as Uint8Array));
    if (method === 'PUT' || method === 'DELETE') {
      if (method === 'DELETE') objects.delete(key);
      return new Response(null, { status: method === 'PUT' ? 200 : 204 });
    }
    const o = objects.get(key);
    return o ? new Response(method === 'HEAD' ? null : o, { status: 200, headers: { 'content-length': String(o.byteLength) } }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
  };
  return { calls, storage: new S3StorageProvider({ endpoint: 'https://t3.storageapi.dev', region: 'auto', bucket: 'media', accessKeyId: 'AKID', secretAccessKey: S3_SECRET, fetch: fetchImpl }) };
}

/** A fake ElevenLabs answering the free lookups; `status` other than 200 refuses them. */
function fakeVoice(status = 200) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (status !== 200) return new Response(JSON.stringify({ detail: { status: 'invalid_api_key', message: `Invalid API key ${VOICE_KEY}` } }), { status });
    if (path === '/v1/voices/voice-abc') return new Response(JSON.stringify({ voice_id: 'voice-abc', name: 'Documentary Narrator' }), { status: 200 });
    if (path === '/v1/models') return new Response(JSON.stringify([{ model_id: 'eleven_v4' }]), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { calls, voice: new ElevenLabsVoiceProvider({ apiKey: VOICE_KEY, model: 'eleven_v4', voiceId: 'voice-abc', outputFormat: 'mp3_44100_128', fetch: fetchImpl }) };
}

async function start(providers?: Partial<ProviderSet>) {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) });
  const env = parseEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL!, NODE_ENV: 'test', WEB_DIST_DIR: '/nonexistent', ELEVENLABS_API_KEY: VOICE_KEY, S3_SECRET_ACCESS_KEY: S3_SECRET });
  const c = createContainer(env, logger, { db, ...(providers ? { providers: { ...createProviders(ALL_MOCK), ...providers } } : {}) });
  const app = await buildApp(c);
  open.push({ app, c });
  const health = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    return { status: res.statusCode, body: res.json<HealthView>(), raw: res.body };
  };
  const checks = () => lines.filter((l) => typeof l.msg === 'string' && l.msg.startsWith('connectivity check'));
  return { c, health, lines, checks };
}

afterEach(async () => {
  for (const { app, c } of open) {
    await app.close();
    await c.close();
  }
  open = [];
  vi.useRealTimers();
});

describe('/api/health connectivity', () => {
  it('reports MOCK storage and voice as mock, checking and logging nothing', async () => {
    const { health, checks } = await start();
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', storage: 'mock', voice: 'mock', storageDetail: null, voiceDetail: null });
    expect(checks()).toEqual([]);
  });

  it('checks real storage and the voice provider once at startup, serves the cached result, and logs it once without secrets', async () => {
    const s3 = fakeS3();
    const el = fakeVoice();
    const { c, health, lines, checks } = await start({ storage: s3.storage, voice: el.voice });
    await c.connectivity.done;
    const replies = [await health(), await health(), await health()];
    for (const { status, body } of replies) {
      expect(status).toBe(200);
      expect(body.storage).toBe('ok');
      expect(body.storageDetail).toMatch(/^wrote, read back and deleted healthchecks\/probe-[0-9a-f-]{36}\.txt in \d+ ms$/);
      expect(body).toMatchObject({ voice: 'ok', voiceDetail: 'voice "Documentary Narrator" found; model eleven_v4 listed' });
    }
    // Once, at startup: health requests reach neither the bucket nor ElevenLabs.
    expect(s3.calls).toEqual(['PUT', 'HEAD', 'GET', 'DELETE']);
    expect(el.calls.sort()).toEqual(['GET /v1/models', 'GET /v1/voices/voice-abc']);
    expect(checks()).toEqual([expect.objectContaining({ level: 30, msg: 'connectivity check passed', storageProvider: 's3', voiceProvider: 'elevenlabs', voiceModel: 'eleven_v4', storage: 'ok', voice: 'ok' })]);
    for (const text of [JSON.stringify(lines), ...replies.map((r) => r.raw)]) {
      expect(text).not.toContain(VOICE_KEY);
      expect(text).not.toContain(S3_SECRET);
    }
  });

  it('reports what failed without crashing startup, keeps HTTP 200 while the database is up, and redacts secrets a vendor echoes', async () => {
    const s3 = fakeS3({ PUT: 403 });
    const el = fakeVoice(401);
    const { c, health, lines, checks } = await start({ storage: s3.storage, voice: el.voice });
    await c.connectivity.done;
    const { status, body, raw } = await health();
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', database: 'ok', storage: 'error', voice: 'error' });
    expect(body.storageDetail).toMatch(/^put failed: \[s3\] PUT healthchecks\/probe-.*\.txt: HTTP 403 AccessDenied: Denied for \[redacted\]$/);
    expect(body.voiceDetail).toBe('voice not confirmed: /v1/voices/voice-abc: HTTP 401: invalid_api_key: Invalid API key [redacted]; model eleven_v4 not confirmed: /v1/models: HTTP 401: invalid_api_key: Invalid API key [redacted]');
    expect(checks()).toEqual([expect.objectContaining({ level: 40, msg: 'connectivity check: a provider is not reachable as configured', storage: 'error', voice: 'error' })]);
    expect(raw + JSON.stringify(lines)).not.toMatch(new RegExp(`${VOICE_KEY}|${S3_SECRET}`));
  });

  it('does not hold a health request for a check still running: the provider reads as not confirmed', async () => {
    const hanging: VoiceProvider = Object.assign(Object.create(new MockVoiceProvider()) as VoiceProvider, { info: { kind: 'VOICE', name: 'slow', mock: false, rates: [] }, check: () => new Promise<never>(() => undefined) });
    const { health } = await start({ voice: hanging });
    const started = Date.now();
    const { status, body } = await health();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(status).toBe(200);
    expect(body).toMatchObject({ storage: 'mock', voice: 'error', voiceDetail: 'Startup check still running' });
  });
});

describe('startConnectivityCheck', () => {
  const quiet = () => {
    const logged: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
    const at = (level: string) => (obj: Record<string, unknown>, msg: string) => void logged.push({ level, obj, msg });
    return { logged, logger: { info: at('info'), warn: at('warn') } as unknown as Parameters<typeof startConnectivityCheck>[1] };
  };

  it(`gives up on a check that has not answered within ${CONNECTIVITY_TIMEOUT_MS / 1000} s, and logs once`, async () => {
    vi.useFakeTimers();
    const { logged, logger } = quiet();
    const hanging = Object.assign(Object.create(new MockVoiceProvider()) as VoiceProvider, { info: { kind: 'VOICE', name: 'slow', mock: false, rates: [] }, check: () => new Promise<never>(() => undefined) });
    const check = startConnectivityCheck({ ...createProviders(ALL_MOCK), voice: hanging }, logger);
    await vi.advanceTimersByTimeAsync(CONNECTIVITY_TIMEOUT_MS);
    expect(await check.done).toEqual({ storage: 'mock', storageDetail: null, voice: 'error', voiceDetail: 'no answer within 15 s' });
    expect(check.current()).toEqual(await check.done);
    expect(logged.map((l) => [l.level, l.msg])).toEqual([['warn', 'connectivity check: a provider is not reachable as configured']]);
  });

  it('says so when a real voice provider has no check, and survives a check that throws', async () => {
    const { logger } = quiet();
    const real = (extra: Partial<VoiceProvider>) => Object.assign(Object.create(new MockVoiceProvider()) as VoiceProvider, { info: { kind: 'VOICE', name: 'other', mock: false, rates: [] }, check: undefined, ...extra });
    expect((await startConnectivityCheck({ ...createProviders(ALL_MOCK), voice: real({}) }, logger).done).voiceDetail).toBe('Not checked: the other voice provider has no connectivity check');
    expect(await startConnectivityCheck({ ...createProviders(ALL_MOCK), voice: real({ check: async () => Promise.reject(new Error('socket hang up')) }) }, logger).done).toMatchObject({ voice: 'error', voiceDetail: 'socket hang up' });
  });
});
