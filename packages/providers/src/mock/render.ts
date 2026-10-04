import type { GraphicRenderRequest, RenderProvider, RenderStatusResult, RenderTicket, TimelineRenderRequest } from '../render.ts';
import type { StorageProvider } from '../storage.ts';
import { ProviderError } from '../types.ts';
import { MOCK_LABEL, mockId, mockInfo, mockMeta } from './common.ts';

/**
 * MOCK renderer. Writes a JSON manifest describing what *would* have been
 * rendered (to `<outputKey>.mock.json`) instead of a video file.
 */
export class MockRenderProvider implements RenderProvider {
  readonly info = mockInfo('RENDER');
  private readonly renders = new Map<string, RenderStatusResult>();

  constructor(private readonly storage: StorageProvider) {}

  async renderTimeline(req: TimelineRenderRequest): Promise<RenderTicket> {
    return this.render('timeline', req.outputKey, { projectId: req.projectId, language: req.language, output: req.output });
  }

  async renderGraphic(req: GraphicRenderRequest): Promise<RenderTicket> {
    return this.render('graphic', req.outputKey, {
      chartType: req.spec.chartType,
      title: req.spec.title,
      language: req.language,
      output: req.output,
      durationSec: req.spec.durationSec,
    });
  }

  async getRenderStatus(renderId: string): Promise<RenderStatusResult> {
    const status = this.renders.get(renderId);
    if (!status) throw new ProviderError('mock', `Unknown render ${renderId}`, false);
    return status;
  }

  private async render(kind: string, outputKey: string, details: Record<string, unknown>): Promise<RenderTicket> {
    const renderId = mockId(`render-${kind}`);
    const manifestKey = `${outputKey}.mock.json`;
    const manifest = { label: MOCK_LABEL, note: 'No media was rendered.', kind, renderId, details, createdAt: new Date().toISOString() };
    await this.storage.put(manifestKey, JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
    this.renders.set(renderId, { renderId, state: 'SUCCEEDED', progress: 1, outputKey: manifestKey });
    return { renderId, state: 'SUCCEEDED', meta: mockMeta([{ unit: 'REQUESTS', quantity: 1 }]) };
  }
}
