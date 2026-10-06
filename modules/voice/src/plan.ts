import { estimateCost, type AuditionCoverageView, type CostBasis, type EffectiveVoiceConfig, type VoiceEstimateView, type VoicePlanChunkView } from '@docengine/core';
import type { VoiceProvider } from '@docengine/providers';
import { chunkSeconds, planChunks, type PlannedChunk } from './chunking.ts';
import { isPlainDelivery } from './performance.ts';
import { prepareTake, type PreparedTake, type TakeBlock } from './prepare.ts';
import { rulesFor, type LexiconEntry } from './pronunciation.ts';
import { findSpokenForms } from './spoken.ts';
import { chunkSections, type VoiceScript, type VoiceScriptBlock } from './script.ts';
import { isQuestion, sentenceSpans } from './text.ts';

/**
 * Planning a voice run before anything is generated: its chunks, what each
 * would send, what it would cost, and what an audition covers. The same
 * preparation runs again at generation time (with the pronunciation list as
 * it is then), with the same effective configuration, so what is planned
 * is what is sent.
 */

export interface PlannedRun {
  chunks: PlannedChunk[];
  takes: PreparedTake[];
  views: VoicePlanChunkView[];
  estimate: Omit<VoiceEstimateView, 'needsConfirmation'>;
}

/** A run's chunks and first takes as they would be made with this configuration (the run's effective configuration). */
export function planRun(script: VoiceScript, blocks: readonly VoiceScriptBlock[], config: EffectiveVoiceConfig, provider: VoiceProvider, words: readonly LexiconEntry[]): PlannedRun {
  const chunks = planChunks(chunkSections(script, blocks), config.chunking);
  const takeBlocks = new Map<string, TakeBlock>([...script.blocks.values()].map((b) => [b.key, { delivery: b.delivery, infoClass: b.infoClass }]));
  const takes = chunks.map((c) => {
    const rules = rulesFor(c.text, words, config.pronunciation.rules);
    return prepareTake({
      chunk: c,
      blocks: takeBlocks,
      strategy: config.strategy,
      numberStyle: config.numberStyle,
      aliases: rules.aliases,
      phonemes: rules.phonemes,
      provider,
      model: config.model,
      settings: config.providerSettings,
      rules: config.performanceRules,
      context: { previousText: null, nextText: null },
      seed: null,
    });
  });
  const characters = takes.reduce((n, t) => n + t.rendered.text.length, 0);
  const cost = estimateCost(provider.info.name, config.model, [{ unit: 'CHARACTERS', quantity: characters }], provider.info.rates);
  let basis: CostBasis;
  let note: string;
  if (provider.info.mock) {
    basis = 'MOCK';
    note = 'MOCK voice: no cost';
  } else if (cost.unpriced.length) {
    basis = 'UNPRICED';
    note = `No price configured for ${config.model}: set ELEVENLABS_USD_PER_1K_CHARS`;
  } else {
    basis = 'ESTIMATED';
    const rate = provider.info.rates.find((r) => r.model === config.model) ?? provider.info.rates.find((r) => !r.model);
    note = `${characters} characters × $${((rate?.usdPerUnit ?? 0) * 1000).toFixed(3)} per 1,000 (${rate?.source ?? 'rate card'})`;
  }
  return {
    chunks,
    takes,
    views: chunks.map((c, i) => ({
      index: c.index,
      sectionKey: c.sectionKey,
      blockKeys: c.spans.map((s) => s.blockKey),
      text: c.text,
      words: c.words,
      boundary: c.boundary,
      performance: c.performance,
      estimatedSec: chunkSeconds(c.words, c.performance),
      performanceText: takes[i]!.rendered.text,
      characters: takes[i]!.rendered.text.length,
      checksPassed: takes[i]!.passed,
    })),
    estimate: {
      chunks: chunks.length,
      words: chunks.reduce((n, c) => n + c.words, 0),
      characters,
      plannedSec: Math.round(blocks.reduce((n, b) => n + b.estimatedDurationSec, 0)),
      estimatedCostUsd: basis === 'UNPRICED' ? null : cost.costUsd,
      costBasis: basis,
      costNote: note,
    },
  };
}

/** What a passage gives a voice to do (to audition it properly, not just prove the API works). */
export function auditionCoverage(script: VoiceScript, blocks: readonly VoiceScriptBlock[], words: readonly LexiconEntry[]): AuditionCoverageView {
  const first = script.sections[0]?.blocks[0];
  const text = blocks.map((b) => b.text).join('\n');
  return {
    dramaticOpening: !!first && blocks.some((b) => b.key === first.key),
    explanatory: blocks.some((b) => b.infoClass === 'DOCUMENTED' && sentenceSpans(b.text).length >= 2),
    rhetoricalQuestion: blocks.some((b) => sentenceSpans(b.text).some((s) => isQuestion(b.text.slice(s.start, s.end)))),
    number: findSpokenForms(text).length > 0,
    nameOrPlace: words.some((w) => text.includes(w.term)) || /\b\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+/u.test(text),
    performanceMoment: blocks.some((b) => !isPlainDelivery(b.delivery) || b.delivery.pauseAfter.length === 'MEDIUM' || b.delivery.pauseAfter.length === 'LONG'),
  };
}
