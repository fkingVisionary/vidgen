import Anthropic from '@anthropic-ai/sdk';
import { estimateCost } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderError } from '../types.ts';
import { ANTHROPIC_RATES, AnthropicAIProvider, type AnthropicClientLike } from './anthropic.ts';

type Msg = Anthropic.Beta.Messages.BetaMessage;

function message(over: Partial<Msg> & { text?: string } = {}): Msg {
  const { text = 'hello', ...rest } = over;
  return {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text, citations: null },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    ...rest,
  } as unknown as Msg;
}

function fakeClient(result: Msg | Error) {
  const calls: { params: Record<string, unknown>; options?: { signal?: AbortSignal } }[] = [];
  const client: AnthropicClientLike = {
    beta: {
      messages: {
        stream(params, options) {
          calls.push({ params: params as Record<string, unknown>, options });
          return { finalMessage: async () => (result instanceof Error ? Promise.reject(result) : result) };
        },
      },
    },
  };
  return { client, calls };
}

describe('AnthropicAIProvider', () => {
  it('requires an API key', () => {
    expect(() => new AnthropicAIProvider({ model: 'claude-opus-5-5' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('streams a request with effort, a cached system prompt and server-side fallbacks', async () => {
    const f = fakeClient(message());
    const ai = new AnthropicAIProvider({ model: 'claude-opus-5-5', client: f.client });
    const signal = new AbortController().signal;
    const r = await ai.generateText({
      task: 't',
      system: 'You are a research analyst.',
      cacheSystemPrompt: true,
      messages: [{ role: 'user', content: 'Hi' }],
      effort: 'high',
      maxTokens: 64_000,
      signal,
    });
    expect(r.text).toBe('hello'); // thinking blocks are ignored
    expect(f.calls[0]!.params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64_000,
      system: [{ type: 'text', text: 'You are a research analyst.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: { effort: 'high' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(f.calls[0]!.params).not.toHaveProperty('thinking'); // adaptive by default; disabling is a 400 on Opus 5.5
    expect(f.calls[0]!.options?.signal).toBe(signal);
  });

  it('reports token usage, request id and the served model; cost is estimable from the rate card', async () => {
    const f = fakeClient(message({ usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 200_000 } as Msg['usage'] }));
    const r = await new AnthropicAIProvider({ model: 'claude-opus-5-5', client: f.client }).generateText({ task: 't', messages: [{ role: 'user', content: 'x' }] });
    expect(r.meta).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', mock: false, providerRequestId: 'msg_123' });
    expect(r.meta.usage).toEqual([
      { unit: 'INPUT_TOKENS', quantity: 1_000_000 },
      { unit: 'OUTPUT_TOKENS', quantity: 100_000 },
      { unit: 'CACHED_INPUT_TOKENS', quantity: 1_000_000 },
      { unit: 'CACHE_WRITE_TOKENS', quantity: 200_000 },
    ]);
    // $4 input + $2 output + $0.20 cache read + $1 cache write
    expect(estimateCost('anthropic', r.meta.model, r.meta.usage, ANTHROPIC_RATES)).toEqual({ costUsd: 7.2, unpriced: [] });
  });

  it('prices by the model that actually served a fallback, and notes it', async () => {
    const msg = message({ model: 'claude-opus-4-8' });
    (msg.usage as unknown as { iterations: unknown[] }).iterations = [{ type: 'fallback_message' }];
    const r = await new AnthropicAIProvider({ model: 'claude-opus-5-5', client: fakeClient(msg).client }).generateText({ task: 't', messages: [] });
    expect(r.meta.model).toBe('claude-opus-4-8');
    expect(r.meta.costNote).toMatch(/refusal fallback/);
  });

  it('returns structured output validated by zod and sends a JSON schema', async () => {
    const schema = z.object({ verdict: z.enum(['MYTH', 'ESTABLISHED']), note: z.string() });
    const f = fakeClient(message({ text: '{"verdict":"MYTH","note":"Mackay, 1841"}' }));
    const r = await new AnthropicAIProvider({ model: 'claude-opus-5-5', client: f.client }).generateObject({ task: 'x', schemaName: 'V', schema, messages: [] });
    expect(r.object).toEqual({ verdict: 'MYTH', note: 'Mackay, 1841' });
    const format = (f.calls[0]!.params.output_config as { format: { type: string; schema: { type: string; properties: object } } }).format;
    expect(format.type).toBe('json_schema');
    expect(format.schema.properties).toHaveProperty('verdict');
  });

  it('falls back to schema-in-instructions when the API rejects the schema as too complex, with the same validation', async () => {
    const tooComplex = new Anthropic.BadRequestError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'The compiled grammar is too large, which would cause performance issues.' } },
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."}}',
      new Headers(),
    );
    const replies: (Msg | Error)[] = [tooComplex, message({ text: 'Here it is:\n```json\n{"verdict":"MYTH","note":"Mackay, 1841"}\n```' })];
    const calls: Record<string, unknown>[] = [];
    const client: AnthropicClientLike = {
      beta: {
        messages: {
          stream(params) {
            calls.push(params as Record<string, unknown>);
            const next = replies.shift()!;
            return { finalMessage: async () => (next instanceof Error ? Promise.reject(next) : next) };
          },
        },
      },
    };
    const schema = z.object({ verdict: z.enum(['MYTH', 'ESTABLISHED']), note: z.string() });
    const ai = new AnthropicAIProvider({ model: 'claude-opus-5-5', client });
    const r = await ai.generateObject({ task: 'research.synthesize', schemaName: 'V', schema, system: 'You are an editor.', messages: [{ role: 'user', content: 'go' }], effort: 'high' });
    expect(r.object).toEqual({ verdict: 'MYTH', note: 'Mackay, 1841' });
    expect(calls).toHaveLength(2);
    expect((calls[0]!.output_config as { format?: unknown }).format).toBeDefined();
    expect(calls[1]!.output_config).toEqual({ effort: 'high' }); // no format: unconstrained, same effort
    const system = (calls[1]!.system as { text: string }[])[0]!.text;
    expect(system).toMatch(/^You are an editor\.\n\nOutput format: reply with one JSON object/);
    expect(system).toContain('"verdict"');
    expect(r.meta.costNote).toMatch(/JSON schema given as instructions/);

    // The fallback output is held to the same schema.
    const replies2: (Msg | Error)[] = [tooComplex, message({ text: '{"verdict":"MAYBE","note":"x"}' })];
    const client2: AnthropicClientLike = {
      beta: { messages: { stream: () => { const next = replies2.shift()!; return { finalMessage: async () => (next instanceof Error ? Promise.reject(next) : next) }; } } },
    };
    await expect(new AnthropicAIProvider({ model: 'claude-opus-5-5', client: client2 }).generateObject({ task: 't', schemaName: 'V', schema, messages: [] })).rejects.toThrow(/did not match V/);

    // Other 400s are not retried this way.
    const other = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 'bad', new Headers());
    const f = fakeClient(other);
    await expect(new AnthropicAIProvider({ model: 'claude-opus-5-5', client: f.client }).generateObject({ task: 't', schemaName: 'V', schema, messages: [] })).rejects.toMatchObject({ retryable: false });
    expect(f.calls).toHaveLength(1);
  });

  it('keeps billed usage on errors when output is invalid JSON or fails the schema', async () => {
    const schema = z.object({ n: z.number() });
    const bad = new AnthropicAIProvider({ model: 'claude-opus-5-5', client: fakeClient(message({ text: '{"n":"seven"}' })).client });
    const err = await bad.generateObject({ task: 'x', schemaName: 'N', schema, messages: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: true });
    expect((err as ProviderError).meta?.usage[0]).toEqual({ unit: 'INPUT_TOKENS', quantity: 1000 });

    const notJson = new AnthropicAIProvider({ model: 'claude-opus-5-5', client: fakeClient(message({ text: 'Sure! Here you go' })).client });
    await expect(notJson.generateObject({ task: 'x', schemaName: 'N', schema, messages: [] })).rejects.toThrow(/not valid JSON/);
  });

  it.each([
    ['refusal', /declined/],
    ['max_tokens', /truncated/],
    ['model_context_window_exceeded', /context window/],
  ] as const)('treats stop_reason=%s as a non-retryable error with usage', async (stop, re) => {
    const ai = new AnthropicAIProvider({ model: 'claude-opus-5-5', client: fakeClient(message({ stop_reason: stop })).client });
    const err = (await ai.generateText({ task: 't', messages: [] }).catch((e: unknown) => e)) as ProviderError;
    expect(err.message).toMatch(re);
    expect(err.retryable).toBe(false);
    expect(err.meta?.usage.length).toBeGreaterThan(0);
  });

  it.each([
    [new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers()), true],
    [new Anthropic.InternalServerError(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 'busy', new Headers()), true],
    [new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 'bad key', new Headers()), false],
    [new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 'bad', new Headers()), false],
    [new Anthropic.APIConnectionError({ message: 'socket hang up' }), true],
  ])('classifies %s (retryable=%s)', async (sdkError, retryable) => {
    const ai = new AnthropicAIProvider({ model: 'claude-opus-5-5', client: fakeClient(sdkError).client });
    await expect(ai.generateText({ task: 't', messages: [] })).rejects.toMatchObject({ retryable });
  });
});
