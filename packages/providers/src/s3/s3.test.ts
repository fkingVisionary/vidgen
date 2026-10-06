import { describe, expect, it } from 'vitest';
import { S3StorageProvider, presignUrl, signHeaders } from './s3.ts';

/**
 * Signature Version 4, checked against the worked examples in the AWS S3
 * documentation ("Signature Calculations for the Authorization Header" and
 * "Authenticating Requests: Using Query Parameters"), then the provider's
 * requests against a recorded fake endpoint.
 */

const EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  date: new Date('2013-05-24T00:00:00Z'),
  host: 'examplebucket.s3.amazonaws.com',
};

describe('AWS Signature Version 4', () => {
  it('signs the documented GET Object example (Range header) to the documented signature', () => {
    const h = signHeaders({ ...EXAMPLE, method: 'GET', path: '/test.txt', headers: { Range: 'bytes=0-9' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('signs the documented PUT Object example (payload hash, $ in the key) to the documented signature', () => {
    const h = signHeaders({
      ...EXAMPLE,
      method: 'PUT',
      path: '/test%24file.text',
      headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    });
    expect(h.authorization).toContain('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('signs the documented GET Bucket (list objects) example, with a sorted query string', () => {
    const h = signHeaders({ ...EXAMPLE, method: 'GET', path: '/', query: { prefix: 'J', 'max-keys': '2' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
    expect(h.authorization).toContain('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('presigns the documented query-string example', () => {
    const url = presignUrl({ ...EXAMPLE, method: 'GET', path: '/test.txt', protocol: 'https:', expiresInSec: 86400 });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
});

describe('the S3 storage provider (fake endpoint, no network)', () => {
  const store = new Map<string, { body: Uint8Array; type: string }>();
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? 'GET', url: url.toString(), auth: headers.get('authorization') });
    const key = decodeURIComponent(url.pathname.slice(1));
    if (init?.method === 'PUT') {
      store.set(key, { body: new Uint8Array(init.body as Uint8Array), type: headers.get('content-type') ?? '' });
      return new Response(null, { status: 200, headers: { etag: '"abc"' } });
    }
    if (init?.method === 'HEAD' || init?.method === 'GET') {
      if (url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const items = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => `<Contents><Key>${k}</Key><Size>${store.get(k)!.body.length}</Size><ETag>"e"</ETag></Contents>`);
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${items.join('')}</ListBucketResult>`, { status: 200 });
      }
      const o = store.get(key);
      if (!o) return new Response('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>', { status: 404 });
      return new Response(init?.method === 'HEAD' ? null : o.body, { status: 200, headers: { 'content-type': o.type, 'content-length': String(o.body.length) } });
    }
    if (init?.method === 'DELETE') {
      store.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected', { status: 500 });
  };
  const s3 = new S3StorageProvider({ endpoint: 'https://t3.storageapi.dev', region: 'auto', bucket: 'media-abc123', accessKeyId: 'AKID', secretAccessKey: 'SECRET', fetch: fakeFetch, now: () => new Date('2026-10-05T12:00:00Z') });

  it('puts, heads, gets, lists and deletes through signed virtual-hosted requests', async () => {
    const key = 'projects/p1/en/narration_audio/a1.mp3';
    const put = await s3.put(key, new Uint8Array([1, 2, 3]), { contentType: 'audio/mpeg', metadata: { take: 'g1' } });
    expect(put).toMatchObject({ key, size: 3, contentType: 'audio/mpeg', etag: 'abc' });
    expect(calls[0]!.url).toBe(`https://media-abc123.t3.storageapi.dev/${key}`);
    expect(calls[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20261005\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-take, Signature=[0-9a-f]{64}$/);
    expect(await s3.head(key)).toMatchObject({ size: 3, contentType: 'audio/mpeg' });
    expect([...(await s3.get(key))]).toEqual([1, 2, 3]);
    expect((await s3.list('projects/p1/')).map((o) => o.key)).toEqual([key]);
    await s3.delete(key);
    expect(await s3.head(key)).toBeNull();
    await expect(s3.get(key)).rejects.toThrow(/HTTP 404 NoSuchKey: The specified key does not exist/);
    // The status is a field, so callers tell a missing object or a refused key from a retryable failure without parsing.
    await expect(s3.get(key)).rejects.toMatchObject({ status: 404, retryable: false });
  });

  it('turns a body that breaks off after the headers into a retryable ProviderError, not a raw DOMException', async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.error(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
          },
        }),
        { status: 200 },
      );
    const flaky = new S3StorageProvider({ endpoint: 'https://t3.storageapi.dev', region: 'auto', bucket: 'media-abc123', accessKeyId: 'AKID', secretAccessKey: 'SECRET', fetch: async () => broken() });
    await expect(flaky.get('projects/p1/a.mp3')).rejects.toMatchObject({
      name: 'ProviderError',
      message: '[s3] GET projects/p1/a.mp3: HTTP 200, then reading the response failed: The operation was aborted due to timeout',
      retryable: true,
      status: 200,
    });
    await expect(flaky.list('projects/p1/')).rejects.toMatchObject({ name: 'ProviderError', message: '[s3] LIST projects/p1/: HTTP 200, then reading the response failed: The operation was aborted due to timeout', retryable: true, status: 200 });
  });

  it('never puts credentials in a presigned URL, and refuses to start without configuration', async () => {
    const url = await s3.getSignedUrl('projects/p1/a.mp3', { expiresInSec: 600 });
    expect(url).toMatch(/^https:\/\/media-abc123\.t3\.storageapi\.dev\/projects\/p1\/a\.mp3\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F20261005%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261005T120000Z&X-Amz-Expires=600&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/);
    expect(url).not.toContain('SECRET');
    expect(() => new S3StorageProvider({ endpoint: 'https://x', region: 'auto', bucket: '', accessKeyId: 'a', secretAccessKey: 'b' })).toThrow(/S3_BUCKET is not set/);
  });
});
