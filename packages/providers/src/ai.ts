import type { z } from 'zod';
import type { CallMeta, ProviderInfo } from './types.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TextGenerationRequest {
  /** Logical task name for logs, cost attribution and mock fixtures, e.g. "research.dossier". */
  task: string;
  system?: string;
  messages: ChatMessage[];
  /** Overrides the provider's default model. */
  model?: string;
  maxTokens?: number;
}

export interface TextGenerationResult {
  text: string;
  stopReason: 'end' | 'max_tokens' | 'refusal' | 'other';
  meta: CallMeta;
}

export interface ObjectGenerationRequest<T> extends TextGenerationRequest {
  /** Output must validate against this schema; real providers send it as a JSON Schema (structured outputs). */
  schema: z.ZodType<T>;
  schemaName: string;
}

export interface ObjectGenerationResult<T> {
  object: T;
  meta: CallMeta;
}

/** Large language model. Planned implementation: Anthropic (Claude). */
export interface AIProvider {
  readonly info: ProviderInfo;
  generateText(req: TextGenerationRequest): Promise<TextGenerationResult>;
  generateObject<T>(req: ObjectGenerationRequest<T>): Promise<ObjectGenerationResult<T>>;
}
