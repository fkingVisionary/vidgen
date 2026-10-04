import { createHash } from 'node:crypto';
import { assertValidKey, type PutOptions, type SignedUrlOptions, type StorageProvider, type StoredObject } from '../storage.ts';
import { mockInfo } from './common.ts';

interface Entry {
  body: Uint8Array;
  contentType: string;
  metadata: Record<string, string>;
  etag: string;
  lastModified: Date;
}

/**
 * MOCK storage: in-memory, per process. Contents vanish on restart. Signed
 * URLs use a `mock-storage://` scheme that no browser can fetch, so nothing
 * pretends to be durably stored.
 */
export class MockStorageProvider implements StorageProvider {
  readonly info = mockInfo('STORAGE');
  private readonly objects = new Map<string, Entry>();

  async put(key: string, body: Uint8Array | string, opts: PutOptions): Promise<StoredObject> {
    assertValidKey(key);
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
    const entry: Entry = {
      body: bytes,
      contentType: opts.contentType,
      metadata: { ...opts.metadata },
      etag: createHash('md5').update(bytes).digest('hex'),
      lastModified: new Date(),
    };
    this.objects.set(key, entry);
    return this.describe(key, entry);
  }

  async get(key: string): Promise<Uint8Array> {
    assertValidKey(key);
    const entry = this.objects.get(key);
    if (!entry) throw new Error(`MOCK storage: object not found: ${key}`);
    return new Uint8Array(entry.body);
  }

  async head(key: string): Promise<StoredObject | null> {
    assertValidKey(key);
    const entry = this.objects.get(key);
    return entry ? this.describe(key, entry) : null;
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => this.describe(key, entry));
  }

  async getSignedUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    assertValidKey(key);
    const expires = Math.floor(Date.now() / 1000) + (opts.expiresInSec ?? 3600);
    return `mock-storage://${key}?method=${opts.method ?? 'GET'}&expires=${expires}`;
  }

  private describe(key: string, e: Entry): StoredObject {
    return { key, size: e.body.byteLength, contentType: e.contentType, etag: e.etag, lastModified: e.lastModified };
  }
}
