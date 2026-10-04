import type { InfographicSpec } from '@docengine/core';
import type { CallMeta, GenerationState, ProviderInfo } from './types.ts';

export interface OutputSpec {
  width: number;
  height: number;
  fps: number;
  container: 'mp4' | 'mov';
  videoCodec?: 'h264' | 'h265' | 'prores';
  /** Integrated loudness target, e.g. -14 LUFS for YouTube. */
  loudnessLufs?: number;
}

export interface TimelineRenderRequest {
  projectId: string;
  language: string;
  /** Timeline document. Its contract is defined in the editing milestone. */
  timeline: unknown;
  output: OutputSpec;
  /** Storage key to write the result to. */
  outputKey: string;
}

export interface GraphicRenderRequest {
  spec: InfographicSpec;
  language: string;
  output: OutputSpec;
  outputKey: string;
}

export interface RenderTicket {
  renderId: string;
  state: GenerationState;
  meta: CallMeta;
}

export interface RenderStatusResult {
  renderId: string;
  state: GenerationState;
  progress?: number;
  outputKey?: string;
  durationMs?: number;
  error?: string;
}

/**
 * Deterministic rendering. Planned implementations: FFmpeg for timeline
 * assembly and audio mixing; Remotion for animated infographics.
 */
export interface RenderProvider {
  readonly info: ProviderInfo;
  renderTimeline(req: TimelineRenderRequest): Promise<RenderTicket>;
  renderGraphic(req: GraphicRenderRequest): Promise<RenderTicket>;
  getRenderStatus(renderId: string): Promise<RenderStatusResult>;
}
