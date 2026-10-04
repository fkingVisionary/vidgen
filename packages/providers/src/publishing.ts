import type { CallMeta, ProviderInfo } from './types.ts';

export type PublishState = 'NOT_PUBLISHED' | 'UPLOADED' | 'PROCESSING' | 'SCHEDULED' | 'PUBLISHED' | 'FAILED';

export interface PublishRequest {
  /** Storage key of the final render. */
  videoKey: string;
  title: string;
  description: string;
  tags: string[];
  language: string;
  categoryId?: string;
  /** Defaults to private: a human makes it public. */
  privacy: 'private' | 'unlisted' | 'public';
  publishAt?: Date;
  thumbnailKey?: string;
  captions?: { language: string; storageKey: string; format: 'srt' | 'vtt' }[];
  madeForKids: boolean;
  /** Platform disclosure for realistic AI-generated/altered content. */
  containsSyntheticMedia: boolean;
}

export interface PublishResult {
  /** Only true when a real platform accepted the upload. */
  published: boolean;
  state: PublishState;
  platformVideoId: string | null;
  url: string | null;
  meta: CallMeta;
}

/** Distribution. Planned implementation: YouTube Data API. */
export interface PublishingProvider {
  readonly info: ProviderInfo;
  uploadVideo(req: PublishRequest): Promise<PublishResult>;
  getPublishStatus(platformVideoId: string): Promise<{ state: PublishState; url: string | null }>;
}
