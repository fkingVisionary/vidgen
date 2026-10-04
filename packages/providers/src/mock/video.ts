import type {
  DownloadedAsset,
  GenerationStatus,
  GenerationTicket,
  ImageGenerationRequest,
  VideoGenerationRequest,
  VideoProvider,
} from '../video.ts';
import { ProviderError, type GenerationState } from '../types.ts';
import { MOCK_FAIL_MARKER, MOCK_LABEL, mockId, mockInfo, mockMeta } from './common.ts';
import { aspectDimensions, placeholderSvg } from './placeholder.ts';

interface MockGeneration {
  kind: 'image' | 'video';
  req: ImageGenerationRequest | VideoGenerationRequest;
  polls: number;
  fail: boolean;
}

/**
 * MOCK image/video generation. Simulates the async lifecycle
 * (QUEUED → RUNNING → SUCCEEDED/FAILED across polls) and downloads a labelled
 * SVG placeholder. It never produces video bytes.
 */
export class MockVideoProvider implements VideoProvider {
  readonly info = mockInfo('VIDEO');
  private readonly generations = new Map<string, MockGeneration>();

  async createImage(req: ImageGenerationRequest): Promise<GenerationTicket> {
    return this.create('image', req, [{ unit: 'IMAGES', quantity: 1 }]);
  }

  async createVideo(req: VideoGenerationRequest): Promise<GenerationTicket> {
    if (!(req.durationSec > 0)) throw new ProviderError('mock', 'durationSec must be positive', false);
    return this.create('video', req, [{ unit: 'VIDEO_SECONDS', quantity: req.durationSec }]);
  }

  async getGenerationStatus(providerJobId: string): Promise<GenerationStatus> {
    const gen = this.get(providerJobId);
    gen.polls += 1;
    const state: GenerationState = gen.polls < 2 ? 'RUNNING' : gen.fail ? 'FAILED' : 'SUCCEEDED';
    return {
      providerJobId,
      state,
      progress: state === 'RUNNING' ? 0.5 : 1,
      ...(state === 'FAILED' ? { error: `${MOCK_LABEL}: simulated generation failure` } : {}),
    };
  }

  async downloadAsset(providerJobId: string): Promise<DownloadedAsset> {
    const gen = this.get(providerJobId);
    if (gen.fail) throw new ProviderError('mock', `Generation ${providerJobId} failed; nothing to download`, false);
    if (gen.polls < 2) throw new ProviderError('mock', `Generation ${providerJobId} has not finished`, true);
    const { width, height } = aspectDimensions(gen.req.aspectRatio);
    const label = gen.kind === 'video' ? `${MOCK_LABEL} VIDEO` : `${MOCK_LABEL} IMAGE`;
    return { data: placeholderSvg({ label, detail: gen.req.prompt, width, height }), mimeType: 'image/svg+xml', placeholder: true };
  }

  private async create(kind: MockGeneration['kind'], req: ImageGenerationRequest, usage: Parameters<typeof mockMeta>[0]) {
    if (!req.prompt.trim()) throw new ProviderError('mock', 'Prompt is empty', false);
    const providerJobId = mockId(kind);
    this.generations.set(providerJobId, { kind, req, polls: 0, fail: req.prompt.includes(MOCK_FAIL_MARKER) });
    return { providerJobId, state: 'QUEUED' as const, meta: mockMeta(usage) };
  }

  private get(providerJobId: string): MockGeneration {
    const gen = this.generations.get(providerJobId);
    if (!gen) throw new ProviderError('mock', `Unknown generation ${providerJobId}`, false);
    return gen;
  }
}
