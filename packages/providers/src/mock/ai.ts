import type {
  AIProvider,
  ObjectGenerationRequest,
  ObjectGenerationResult,
  TextGenerationRequest,
  TextGenerationResult,
} from '../ai.ts';
import { ProviderError } from '../types.ts';
import { MOCK_FAIL_MARKER, MOCK_LABEL, mockInfo, mockMeta } from './common.ts';

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * MOCK LLM. It does not pretend to think: text output is an explicit MOCK
 * echo, and structured output only comes from fixtures registered per task
 * (validated against the request schema), never invented.
 */
export class MockAIProvider implements AIProvider {
  readonly info = mockInfo('AI');

  constructor(private readonly fixtures: Record<string, unknown> = {}) {}

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const prompt = req.messages.map((m) => m.content).join('\n');
    if (prompt.includes(MOCK_FAIL_MARKER)) throw new ProviderError('mock', 'Simulated LLM failure', true);
    const last = req.messages.at(-1)?.content ?? '';
    const text = `[${MOCK_LABEL}] ${req.task}: no language model was called. Prompt began: "${last.slice(0, 120)}"`;
    return {
      text,
      stopReason: 'end',
      meta: mockMeta([
        { unit: 'INPUT_TOKENS', quantity: approxTokens((req.system ?? '') + prompt) },
        { unit: 'OUTPUT_TOKENS', quantity: approxTokens(text) },
      ]),
    };
  }

  async generateObject<T>(req: ObjectGenerationRequest<T>): Promise<ObjectGenerationResult<T>> {
    if (!(req.task in this.fixtures)) {
      throw new ProviderError(
        'mock',
        `No MOCK fixture registered for task "${req.task}" (schema ${req.schemaName}). Mock mode never invents structured content.`,
        false,
      );
    }
    const parsed = req.schema.safeParse(this.fixtures[req.task]);
    if (!parsed.success) {
      throw new ProviderError('mock', `MOCK fixture for "${req.task}" does not match ${req.schemaName}: ${parsed.error.message}`, false);
    }
    return {
      object: parsed.data,
      meta: mockMeta([{ unit: 'INPUT_TOKENS', quantity: approxTokens(JSON.stringify(req.messages)) }]),
    };
  }
}
