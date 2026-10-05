import { createHash, createHmac } from 'node:crypto';
import { assertValidKey, type PutOptions, type SignedUrlOptions, type StorageProvider, type StoredObject } from '../storage.ts';
import { ProviderError, type ProviderInfo } from '../types.ts';

/**
 * S3-compatible object storage (Railway Storage Buckets, Cloudflare R2,
 * AWS S3, MinIO) over plain HTTPS with AWS Signature Version 4 — no SDK.
 * Buckets stay private: the browser never sees credentials, and media is
 * served through the API (or a short-lived presigned URL).
 */

export interface S3Options {
  /** e.g. https://t3.storageapi.dev (Railway), https://<account>.r2.cloudflarestorage.com (R2). */
  endpoint: string;
  /** Signing region ("auto" for Railway and R2). */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (endpoint/bucket/key) instead of virtual-hosted (bucket.endpoint/key). */
  forcePathStyle?: boolean;
  signedUrlTtlSec?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => Date;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Uint8Array | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* unescaped). */
export const encodeRfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SigV4Input {
  method: string;
  /** Host header value. */
  host: string;
  /** Canonical (already encoded) path, e.g. "/test.txt". */
  path: string;
  query?: Record<string, string>;
  /** Headers to sign (besides host); names any case. */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
  service?: string;
}

const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

function canonicalQuery(q: Record<string, string>): string {
  return Object.entries(q)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function signature(input: SigV4Input, signedHeaders: Record<string, string>, query: Record<string, string>): { signature: string; signedHeaderNames: string; scope: string; stamp: string } {
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const service = input.service ?? 's3';
  const names = Object.keys(signedHeaders).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signedHeaders[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaderNames = names.join(';');
  const canonicalRequest = [input.method, input.path, canonicalQuery(query), canonicalHeaders, signedHeaderNames, input.payloadHash].join('\n');
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service), 'aws4_request');
  return { signature: createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex'), signedHeaderNames, scope, stamp };
}

/** The Authorization header (and x-amz-date) for a request signed in the header. */
export function signHeaders(input: SigV4Input): Record<string, string> {
  const stamp = amzDate(input.date);
  const headers: Record<string, string> = { host: input.host, 'x-amz-date': stamp, 'x-amz-content-sha256': input.payloadHash };
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  const s = signature(input, headers, input.query ?? {});
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${s.scope}, SignedHeaders=${s.signedHeaderNames}, Signature=${s.signature}`,
  };
}

/** A presigned URL (query-string authentication; only the host header is signed). */
export function presignUrl(input: Omit<SigV4Input, 'payloadHash' | 'headers'> & { protocol: string; expiresInSec: number }): string {
  const stamp = amzDate(input.date);
  const scope = `${stamp.slice(0, 8)}/${input.region}/${input.service ?? 's3'}/aws4_request`;
  const query: Record<string, string> = {
    ...(input.query ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(input.expiresInSec),
    'X-Amz-SignedHeaders': 'host',
  };
  const s = signature({ ...input, payloadHash: 'UNSIGNED-PAYLOAD' }, { host: input.host }, query);
  return `${input.protocol}//${input.host}${input.path}?${canonicalQuery(query)}&X-Amz-Signature=${s.signature}`;
}

const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

export class S3StorageProvider implements StorageProvider {
  readonly info: ProviderInfo = { kind: 'STORAGE', name: 's3', mock: false, rates: [] };
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: S3Options) {
    for (const [name, v] of Object.entries({ S3_ENDPOINT: opts.endpoint, S3_BUCKET: opts.bucket, S3_ACCESS_KEY_ID: opts.accessKeyId, S3_SECRET_ACCESS_KEY: opts.secretAccessKey })) {
      if (!v) throw new ProviderError('s3', `${name} is not set`, false);
    }
    this.endpoint = new URL(opts.endpoint);
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
  }

  private target(key: string | null): { host: string; path: string } {
    const encoded = key === null ? '' : key.split('/').map(encodeRfc3986).join('/');
    if (this.opts.forcePathStyle) return { host: this.endpoint.host, path: `/${encodeRfc3986(this.opts.bucket)}/${encoded}` };
    return { host: `${this.opts.bucket}.${this.endpoint.host}`, path: `/${encoded}` };
  }

  private async send(method: string, key: string | null, opts: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    const { host, path } = this.target(key);
    const payloadHash = opts.body ? sha256hex(opts.body) : EMPTY_SHA256;
    const headers = signHeaders({ method, host, path, query: opts.query ?? {}, headers: opts.headers ?? {}, payloadHash, region: this.opts.region, accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey, date: this.now() });
    const qs = opts.query && Object.keys(opts.query).length ? `?${canonicalQuery(opts.query)}` : '';
    delete headers.host;
    try {
      return await this.fetchImpl(`${this.endpoint.protocol}//${host}${path}${qs}`, {
        method,
        headers,
        ...(opts.body ? { body: opts.body } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw new ProviderError('s3', `${method} ${key ?? '(bucket)'}: ${err instanceof Error ? err.message : String(err)}`, true, { cause: err });
    }
  }

  private async fail(res: Response, what: string): Promise<never> {
    const body = await res.text().catch(() => '');
    const code = tag(body, 'Code');
    const message = tag(body, 'Message');
    throw new ProviderError('s3', `${what}: HTTP ${res.status}${code ? ` ${code}` : ''}${message ? `: ${decodeXml(message)}` : ''}`, res.status === 429 || res.status >= 500);
  }

  async put(key: string, body: Uint8Array | string, opts: PutOptions): Promise<StoredObject> {
    assertValidKey(key);
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const meta: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.metadata ?? {})) meta[`x-amz-meta-${k.toLowerCase()}`] = v;
    const res = await this.send('PUT', key, { body: bytes, headers: { 'content-type': opts.contentType, ...meta } });
    if (!res.ok) await this.fail(res, `PUT ${key}`);
    return { key, size: bytes.byteLength, contentType: opts.contentType, ...(res.headers.get('etag') ? { etag: res.headers.get('etag')!.replace(/"/g, '') } : {}) };
  }

  async get(key: string): Promise<Uint8Array> {
    assertValidKey(key);
    const res = await this.send('GET', key);
    if (!res.ok) await this.fail(res, `GET ${key}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async head(key: string): Promise<StoredObject | null> {
    assertValidKey(key);
    const res = await this.send('HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, `HEAD ${key}`);
    const modified = res.headers.get('last-modified');
    return {
      key,
      size: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      ...(res.headers.get('etag') ? { etag: res.headers.get('etag')!.replace(/"/g, '') } : {}),
      ...(modified ? { lastModified: new Date(modified) } : {}),
    };
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    const res = await this.send('DELETE', key);
    if (!res.ok && res.status !== 404) await this.fail(res, `DELETE ${key}`);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
      const res = await this.send('GET', null, { query });
      if (!res.ok) await this.fail(res, `LIST ${prefix}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const c = m[1]!;
        const modified = tag(c, 'LastModified');
        out.push({
          key: decodeXml(tag(c, 'Key') ?? ''),
          size: Number(tag(c, 'Size') ?? 0),
          contentType: 'application/octet-stream',
          ...(tag(c, 'ETag') ? { etag: decodeXml(tag(c, 'ETag')!).replace(/"/g, '') } : {}),
          ...(modified ? { lastModified: new Date(modified) } : {}),
        });
      }
      token = tag(xml, 'IsTruncated') === 'true' ? decodeXml(tag(xml, 'NextContinuationToken') ?? '') || undefined : undefined;
    } while (token);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async getSignedUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    assertValidKey(key);
    const { host, path } = this.target(key);
    return presignUrl({
      method: opts.method ?? 'GET',
      host,
      path,
      protocol: this.endpoint.protocol,
      region: this.opts.region,
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      date: this.now(),
      expiresInSec: opts.expiresInSec ?? this.opts.signedUrlTtlSec ?? 3600,
    });
  }
}
