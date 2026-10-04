import type { PublishRequest, PublishResult, PublishState, PublishingProvider } from '../publishing.ts';
import { mockInfo, mockMeta } from './common.ts';

/**
 * MOCK publishing. Never claims success: `published` is always false and no
 * video id or URL is returned. The pipeline will not mark a project
 * PUBLISHED from a mock publish.
 */
export class MockPublishingProvider implements PublishingProvider {
  readonly info = mockInfo('PUBLISHING');

  async uploadVideo(req: PublishRequest): Promise<PublishResult> {
    if (!req.title.trim()) throw new Error('Title is required');
    return { published: false, state: 'NOT_PUBLISHED', platformVideoId: null, url: null, meta: mockMeta([{ unit: 'REQUESTS', quantity: 1 }]) };
  }

  async getPublishStatus(): Promise<{ state: PublishState; url: string | null }> {
    return { state: 'NOT_PUBLISHED', url: null };
  }
}
