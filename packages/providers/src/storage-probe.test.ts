import { describe, expect, it } from 'vitest';
import { MockStorageProvider } from './mock/storage.ts';
import { S3StorageProvider } from './s3/s3.ts';
import { PROBE_PREFIX, probeStorage, type StorageProvider } from './storage.ts';

/** The storage probe against the MOCK, a fake S3 endpoint and stores that fail at each step. No network. */

/** A fake S3 bucket; `refuse` answers a method with an S3 error instead. */
function fakeS3(refuse: Record<string, [number, string]> = {}) {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const key = decodeURIComponent(new URL(String(input)).pathname.slice(1));
    calls.push(`${method} ${key}`);
    const refused = refuse[method];
    if (refused) return new Response(`<Error><Code>${refused[1]}</Code><Message>Refused by the fake</Message></Error>`, { status: refused[0] });
    if (method === 'PUT') {
      objects.set(key, new Uint8Array(init!.body as Uint8Array));
      return new Response(null, { status: 200, headers: { etag: '"e"' } });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const o = objects.get(key);
    if (!o) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    return new Response(method === 'HEAD' ? null : o, { status: 200, headers: { 'content-length': String(o.byteLength), 'content-type': 'text/plain' } });
  };
  const s3 = new S3StorageProvider({ endpoint: 'https://t3.storageapi.dev', region: 'auto', bucket: 'media-abc', accessKeyId: 'AKID', secretAccessKey: 'SECRET-never-shown', fetch: fetchImpl });
  return { s3, objects, calls };
}

/** Wraps a store so one operation behaves differently. */
const tamper = (base: StorageProvider, override: Partial<Pick<StorageProvider, 'put' | 'head' | 'get' | 'delete'>>): StorageProvider =>
  Object.assign(Object.create(base) as StorageProvider, override);

describe('probeStorage', () => {
  it('writes, reads back, compares and deletes one tiny object under healthchecks/ (MOCK)', async () => {
    const storage = new MockStorageProvider();
    const probe = await probeStorage(storage);
    expect(probe.ok).toBe(true);
    expect(probe.detail).toMatch(/^wrote, read back and deleted healthchecks\/probe-[0-9a-f-]{36}\.txt in \d+ ms$/);
    expect(await storage.list(PROBE_PREFIX)).toEqual([]);
  });

  it('goes through a real S3 provider in order: PUT, HEAD, GET, DELETE, and leaves nothing behind', async () => {
    const { s3, objects, calls } = fakeS3();
    expect((await probeStorage(s3)).ok).toBe(true);
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['PUT', 'HEAD', 'GET', 'DELETE']);
    expect(calls.every((c) => c.split(' ')[1]!.startsWith(PROBE_PREFIX))).toBe(true);
    expect(objects.size).toBe(0);
  });

  it('fails cleanly, saying which step failed and why, and never shows a secret', async () => {
    const denied = fakeS3({ PUT: [403, 'AccessDenied'] });
    const probe = await probeStorage(denied.s3);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/^put failed: \[s3\] PUT healthchecks\/probe-[0-9a-f-]{36}\.txt: HTTP 403 AccessDenied: Refused by the fake$/);
    expect(probe.detail).not.toContain('SECRET');

    const unreadable = fakeS3({ GET: [500, 'InternalError'] });
    expect((await probeStorage(unreadable.s3)).detail).toMatch(/^get failed: .*HTTP 500 InternalError/);
    // The object is still deleted.
    expect(unreadable.objects.size).toBe(0);

    const offline = new S3StorageProvider({ endpoint: 'https://t3.storageapi.dev', region: 'auto', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', fetch: async () => Promise.reject(new TypeError('fetch failed')) });
    expect(await probeStorage(offline)).toEqual({ ok: false, detail: expect.stringMatching(/^put failed: \[s3\] PUT healthchecks\/.*: fetch failed$/) });
  });

  it('catches a store that loses or changes what it was given, and cleans up after it', async () => {
    const base = new MockStorageProvider();
    expect((await probeStorage(tamper(base, { head: async () => null }))).detail).toBe('head failed: the object just written is not there');
    expect((await probeStorage(tamper(base, { get: async () => new TextEncoder().encode('something else') }))).detail).toBe('get failed: read back different bytes');
    expect(await base.list(PROBE_PREFIX)).toEqual([]);
    // Even a delete that throws is reported, not thrown.
    expect((await probeStorage(tamper(base, { delete: async () => Promise.reject(new Error('no delete permission')) }))).detail).toBe('delete failed: no delete permission');
  });
});
