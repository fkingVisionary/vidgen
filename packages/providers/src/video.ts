import type { AspectRatio } from '@docengine/core';
import type { CallMeta, GenerationState, ProviderInfo } from './types.ts';

export type { AspectRatio };

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  aspectRatio: AspectRatio;
  model?: string;
  seed?: number;
  /** Continuity references (character/location/object bible images). */
  referenceImageUrls?: string[];
}

export interface VideoGenerationRequest extends ImageGenerationRequest {
  durationSec: number;
  cameraMotion?: string;
  /** Image-to-video: animate an approved still. */
  sourceImageUrl?: string;
}

export interface GenerationTicket {
  providerJobId: string;
  state: GenerationState;
  meta: CallMeta;
}

export interface GenerationStatus {
  providerJobId: string;
  state: GenerationState;
  /** 0–1 when the vendor reports it. */
  progress?: number;
  error?: string;
}

export interface DownloadedAsset {
  data: Uint8Array;
  mimeType: string;
  /** True when the bytes are a stand-in (MOCK), not real generated media. */
  placeholder: boolean;
}

/**
 * Cinematic image/video generation. Async: create → poll status → download.
 * Planned implementation: Higgsfield. All vendor calls live in that one
 * implementation; nothing else in the app talks to the vendor.
 */
export interface VideoProvider {
  readonly info: ProviderInfo;
  createImage(req: ImageGenerationRequest): Promise<GenerationTicket>;
  createVideo(req: VideoGenerationRequest): Promise<GenerationTicket>;
  getGenerationStatus(providerJobId: string): Promise<GenerationStatus>;
  downloadAsset(providerJobId: string): Promise<DownloadedAsset>;
}

/** Polls until a generation finishes. Stage code uses this instead of hand-rolled loops. */
export async function waitForGeneration(
  provider: VideoProvider,
  providerJobId: string,
  opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GenerationStatus> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  for (;;) {
    opts.signal?.throwIfAborted();
    const status = await provider.getGenerationStatus(providerJobId);
    if (status.state === 'SUCCEEDED' || status.state === 'FAILED') return status;
    if (Date.now() >= deadline) {
      throw new Error(`Generation ${providerJobId} did not finish within ${opts.timeoutMs ?? 900_000}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
