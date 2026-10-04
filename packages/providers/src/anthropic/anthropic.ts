import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Rate, UsageItem } from '@docengine/core';
import type {
  AIProvider,
  ObjectGenerationRequest,
  ObjectGenerationResult,
  TextGenerationRequest,
  TextGenerationResult,
} from '../ai.ts';
import { ProviderError, type CallMeta, type ProviderInfo } from '../types.ts';

/**
 * Anthropic Claude via the official SDK.
 *
 * - Streaming for every request (long syntheses would hit HTTP timeouts otherwise).
 * - Structured output through `output_config.format` (JSON Schema from zod),
 *   validated with zod on our side so usage is still recorded if validation fails.
 * - Thinking is adaptive (always on for Claude Opus 5.5); `effort` controls depth.
 * - Server-side refusal fallbacks (`fallbacks: "default"`): if a safety
 *   classifier declines, Anthropic re-runs the request on its recommended
 *   fallback model inside the same call. The served model is recorded and priced.
 * - The API reports tokens, not dollars, so cost is an ESTIMATE from the rate card below.
 */

const PRICING_SOURCE = 'Anthropic list prices per MTok (Claude API reference, cached 2026-09-25); cache write = 5-minute TTL';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** USD per million tokens: [input, output, cache read, cache write (5 min)]. */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-opus-5': [5, 25, 0.5, 6.25],
  'claude-opus-4-8': [5, 25, 0.5, 6.25],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
  'claude-fable-5-1': [10, 50, 0.25, 12.5],
};

export const ANTHROPIC_RATES: Rate[] = Object.entries(PRICES).flatMap(([model, [input, output, cacheRead, cacheWrite]]) => [
  { provider: 'anthropic', model, unit: 'INPUT_TOKENS' as const, usdPerUnit: input / 1e6, source: PRICING_SOURCE },
  { provider: 'anthropic', model, unit: 'OUTPUT_TOKENS' as const, usdPerUnit: output / 1e6, source: PRICING_SOURCE },
  { provider: 'anthropic', model, unit: 'CACHED_INPUT_TOKENS' as const, usdPerUnit: cacheRead / 1e6, source: PRICING_SOURCE },
  { provider: 'anthropic', model, unit: 'CACHE_WRITE_TOKENS' as const, usdPerUnit: cacheWrite / 1e6, source: PRICING_SOURCE },
]);

/** The subset of the SDK client this provider uses (lets tests inject a fake). */
export interface AnthropicClientLike {
  beta: {
    messages: {
      stream(
        params: Anthropic.Beta.Messages.MessageCreateParamsStreaming | Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): { finalMessage(): Promise<Anthropic.Beta.Messages.BetaMessage> };
    };
  };
}

export interface AnthropicOptions {
  apiKey?: string;
  model: string;
  maxRetries?: number;
  client?: AnthropicClientLike;
}

export class AnthropicAIProvider implements AIProvider {
  readonly info: ProviderInfo = { kind: 'AI', name: 'anthropic', mock: false, rates: ANTHROPIC_RATES };
  private readonly client: AnthropicClientLike;

  constructor(private readonly opts: AnthropicOptions) {
    if (!opts.client && !opts.apiKey) throw new ProviderError('anthropic', 'ANTHROPIC_API_KEY is not set', false);
    this.client =
      opts.client ??
      (new Anthropic({
        apiKey: opts.apiKey,
        maxRetries: opts.maxRetries ?? 2, // SDK retries 408/409/429/5xx/connection errors with backoff
        timeout: 30 * 60_000, // long structured syntheses
      }) as unknown as AnthropicClientLike);
  }

  async generateText(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const msg = await this.run(req, undefined);
    return { text: textOf(msg), stopReason: 'end', meta: this.meta(msg) };
  }

  async generateObject<T>(req: ObjectGenerationRequest<T>): Promise<ObjectGenerationResult<T>> {
    // JSON Schema derived from the zod schema (the SDK adapts it to what structured outputs support).
    const { schema } = betaZodOutputFormat(req.schema);
    const msg = await this.run(req, { type: 'json_schema', schema });
    const meta = this.meta(msg);
    const text = textOf(msg);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError('anthropic', `${req.task}: structured output was not valid JSON`, true, { meta });
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new ProviderError('anthropic', `${req.task}: output did not match ${req.schemaName} (${issues})`, true, { meta });
    }
    return { object: parsed.data, meta };
  }

  private async run(req: TextGenerationRequest, format: Record<string, unknown> | undefined): Promise<Anthropic.Beta.Messages.BetaMessage> {
    const params = {
      model: req.model ?? this.opts.model,
      max_tokens: req.maxTokens ?? 32_000,
      ...(req.system
        ? {
            system: [
              { type: 'text', text: req.system, ...(req.cacheSystemPrompt ? { cache_control: { type: 'ephemeral' } } : {}) },
            ],
          }
        : {}),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { ...(req.effort ? { effort: req.effort } : {}), ...(format ? { format } : {}) },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    };

    let msg: Anthropic.Beta.Messages.BetaMessage;
    try {
      msg = await this.client.beta.messages.stream(params, req.signal ? { signal: req.signal } : undefined).finalMessage();
    } catch (err) {
      throw toProviderError(req.task, err);
    }

    switch (msg.stop_reason) {
      case 'end_turn':
      case 'stop_sequence':
        return msg;
      case 'refusal': {
        const details = (msg as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
        throw new ProviderError('anthropic', `${req.task}: declined (refusal${details?.category ? `, ${details.category}` : ''})`, false, { meta: this.meta(msg) });
      }
      case 'max_tokens':
        throw new ProviderError('anthropic', `${req.task}: output truncated at max_tokens=${params.max_tokens}`, false, { meta: this.meta(msg) });
      case 'model_context_window_exceeded':
        throw new ProviderError('anthropic', `${req.task}: input exceeds the model's context window`, false, { meta: this.meta(msg) });
      default:
        throw new ProviderError('anthropic', `${req.task}: unexpected stop_reason ${String(msg.stop_reason)}`, false, { meta: this.meta(msg) });
    }
  }

  private meta(msg: Anthropic.Beta.Messages.BetaMessage): CallMeta {
    const u = msg.usage;
    const usage: UsageItem[] = [
      { unit: 'INPUT_TOKENS', quantity: u.input_tokens ?? 0 },
      { unit: 'OUTPUT_TOKENS', quantity: u.output_tokens ?? 0 },
    ];
    if (u.cache_read_input_tokens) usage.push({ unit: 'CACHED_INPUT_TOKENS', quantity: u.cache_read_input_tokens });
    if (u.cache_creation_input_tokens) usage.push({ unit: 'CACHE_WRITE_TOKENS', quantity: u.cache_creation_input_tokens });
    const fallback = ((u as { iterations?: { type?: string }[] | null }).iterations ?? []).some((i) => i.type === 'fallback_message');
    return {
      provider: 'anthropic',
      model: msg.model, // the model that actually served the request
      mock: false,
      usage,
      providerRequestId: msg.id,
      costNote: `Estimated from token usage × list price for ${msg.model}${fallback ? ` (served by refusal fallback; requested ${this.opts.model})` : ''}`,
    };
  }
}

function textOf(msg: Anthropic.Beta.Messages.BetaMessage): string {
  return msg.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function toProviderError(task: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError('anthropic', `${task}: connection failed: ${err.message}`, true, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    // 429 rate limit, 529 overloaded, other 5xx: transient. 400/401/403/404/413/422: fix the request or config.
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    return new ProviderError('anthropic', `${task}: HTTP ${status || '?'}: ${err.message}`, retryable, { cause: err });
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new ProviderError('anthropic', `${task}: aborted`, false, { cause: err });
  }
  return new ProviderError('anthropic', `${task}: ${err instanceof Error ? err.message : String(err)}`, true, { cause: err });
}
