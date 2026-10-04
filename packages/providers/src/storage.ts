import type { AssetKind } from '@docengine/core';
import type { ProviderInfo } from './types.ts';

export interface PutOptions {
  contentType: string;
  metadata?: Record<string, string>;
}

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified?: Date;
}

export interface SignedUrlOptions {
  /** Default 3600. */
  expiresInSec?: number;
  method?: 'GET' | 'PUT';
  contentType?: string;
}

/**
 * Object storage. Designed for S3-compatible services (Cloudflare R2, AWS S3,
 * MinIO). The browser only ever receives short-lived signed URLs — never
 * credentials.
 */
export interface StorageProvider {
  readonly info: ProviderInfo;
  put(key: string, body: Uint8Array | string, opts: PutOptions): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
  getSignedUrl(key: string, opts?: SignedUrlOptions): Promise<string>;
}

export class StorageKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`Invalid storage key "${key}": ${reason}`);
    this.name = 'StorageKeyError';
  }
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

export function assertValidKey(key: string): void {
  if (key.length === 0 || key.length > 1024) throw new StorageKeyError(key, 'length must be 1–1024');
  if (!KEY_PATTERN.test(key)) throw new StorageKeyError(key, 'only letters, digits, . _ - / allowed; no leading slash');
  if (key.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new StorageKeyError(key, 'empty, "." and ".." path segments are not allowed');
  }
}

/**
 * Canonical object key for a project asset:
 *   projects/{projectId}/{language | "shared"}/{kind}/{assetId}.{ext}
 * "shared" holds language-neutral assets (visuals, maps) reused by every language.
 */
export function buildAssetKey(parts: {
  projectId: string;
  language?: string | null;
  kind: AssetKind;
  assetId: string;
  ext: string;
}): string {
  const scope = parts.language ?? 'shared';
  const key = `projects/${parts.projectId}/${scope}/${parts.kind.toLowerCase()}/${parts.assetId}.${parts.ext.replace(/^\./, '')}`;
  assertValidKey(key);
  return key;
}
