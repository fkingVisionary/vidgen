import {
  CHUNK_SECONDS,
  DEFAULT_VOICE_PROFILE_CONFIG,
  VOICE_ACCEPTANCE_EXPERIMENT,
  wordsForSeconds,
  type EffectiveVoiceConfig,
  type VoiceChunkView,
  type VoiceConfigOverrides,
  type VoicePlanView,
  type VoiceSettingDescriptor,
  type VoiceTakeConfigView,
} from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { sentenceSpans as engineSentences } from '../../../modules/voice/src/text.ts';
import { ELEVENLABS_MODELS } from '../../../packages/providers/src/elevenlabs/models.ts';
import { ELEVENLABS_SETTINGS } from '../../../packages/providers/src/elevenlabs/settings.ts';
import { sentVoiceSettings } from '../../../packages/providers/src/voice-settings.ts';
import {
  CHUNK_SIZES,
  configDifferences,
  configRows,
  costText,
  costWords,
  describeOverrides,
  experimentRuns,
  isEmptyOverrides,
  notSentTo,
  originText,
  outsideNatural,
  overrideProblems,
  parseDirections,
  plansEstimate,
  productionMode,
  productionRefusal,
  profileLabel,
  pruneOverrides,
  sameOverrides,
  sentenceSpans,
  settingProblem,
  sizeLabel,
  takeCostText,
  takeLabels,
  takesEstimate,
  versionEffective,
} from './voice-plan.ts';

describe('chunk sizes', () => {
  it('are the engine’s seconds at the narration rate: below, at and above the target', () => {
    const { natural, target } = CHUNK_SECONDS;
    expect(CHUNK_SIZES.map((s) => s.label)).toEqual(['≈5–8 s', '≈8–12 s', '≈12–20 s']);
    expect(CHUNK_SIZES.map((s) => s.chunking)).toEqual([
      { minWords: wordsForSeconds(natural.min), maxWords: wordsForSeconds(target.min) },
      { minWords: wordsForSeconds(target.min), maxWords: wordsForSeconds(target.max) },
      { minWords: wordsForSeconds(target.max), maxWords: wordsForSeconds(natural.max) },
    ]);
    expect(sizeLabel(CHUNK_SIZES[1]!.chunking)).toBe('20–30 words (≈8–12 s)');
  });

  it('match the acceptance experiment’s F and G', () => {
    const by = (letter: string) => VOICE_ACCEPTANCE_EXPERIMENT.variants.find((v) => v.label.startsWith(letter))!.chunking;
    expect(by('F')).toEqual(CHUNK_SIZES[0]!.chunking);
    expect(by('B')).toEqual(CHUNK_SIZES[1]!.chunking);
    expect(by('G')).toEqual(CHUNK_SIZES[2]!.chunking);
  });

  it('flag seconds outside the natural range only', () => {
    expect([4.9, 5, 12, 20, 20.1].map(outsideNatural)).toEqual([true, false, false, false, true]);
  });
});

describe('sentence numbers', () => {
  const texts = [
    'Dr. Brennan arrived. He left.',
    'J. P. Coen sailed for Batavia. Then?',
    'It cost 1.5 guilders… What changed hands was not a flower. It was a promise.',
    '"Why?" she asked. "Because the price had doubled."',
    'One sentence.\nA second block, a second sentence',
    'Was it c. 1637? Yes. No. 5 was sold e.g. in Haarlem.',
    '(See above.) Next, the courts.',
    'He waited...  Nothing came. etc. And then',
    'In 1637 a bulb sold for 5,200 guilders. Thijs bought one!',
    '',
  ];

  it('are the engine’s: the dashboard splits every text exactly as modules/voice does', () => {
    for (const t of texts) expect(sentenceSpans(t), t).toEqual(engineSentences(t));
  });
});

describe('directions', () => {
  it('read one line per sentence, by the chunk’s numbers', () => {
    expect(parseDirections('2: curious\n3: quiet, deliberate', 3)).toEqual([
      { sentence: 1, emotion: 'curious' },
      { sentence: 2, emotion: 'quiet', delivery: 'deliberate' },
    ]);
    expect(parseDirections('', 2)).toEqual([]);
  });

  it('refuse a sentence the chunk does not have (the engine would drop it and the take be paid for without it)', () => {
    expect(parseDirections('3: curious', 2)).toBeNull();
    expect(parseDirections('0: curious', 2)).toBeNull();
  });

  it('refuse the same sentence twice, and words the contract refuses', () => {
    expect(parseDirections('1: curious\n1: quiet', 2)).toBeNull();
    expect(parseDirections('1: a', 2)).toBeNull();
    expect(parseDirections(`1: ${'very '.repeat(8)}quiet`, 2)).toBeNull();
    expect(parseDirections('1 curious', 2)).toBeNull();
  });
});

describe('estimates before a confirmation', () => {
  const take = (characters: number | null, performanceText: string | null = null) => ({ characters, performanceText }) as VoiceChunkView['generations'][number];
  const chunk = (text: string, current: ReturnType<typeof take> | null, generations: ReturnType<typeof take>[] = current ? [current] : []) => ({ text, current, generations }) as VoiceChunkView;

  it('count what each chunk’s last take sent, priced at the run’s own rate', () => {
    const chunks = [chunk('a'.repeat(50), take(120)), chunk('b'.repeat(40), null, [take(null, 'x'.repeat(70)), take(90)]), chunk('c'.repeat(30), null)];
    const e = takesEstimate(chunks, 2, { characters: 1000, cost: { totalUsd: 0.08, basis: 'ESTIMATED' } }, false);
    expect(e).toEqual({ takes: 6, characters: 2 * (120 + 90 + 30), costUsd: (0.08 / 1000) * 480, mock: false });
    expect(costWords(e)).toBe('~$0.04 estimated');
  });

  it('never make a price up', () => {
    const e = takesEstimate([chunk('abc', take(3))], 1, { characters: 0, cost: { totalUsd: 0, basis: null } }, false);
    expect(e.costUsd).toBeNull();
    expect(costWords(e)).toBe('cost unknown (no price yet)');
    expect(costWords(takesEstimate([chunk('abc', take(3))], 1, { characters: 10, cost: { totalUsd: 1, basis: 'MOCK' } }, true))).toBe('MOCK voice: no cost');
  });

  it('total a comparison, unpriced when any variant is', () => {
    const plan = (characters: number, estimatedCostUsd: number | null, costBasis: VoicePlanView['estimate']['costBasis']) => ({ estimate: { chunks: 3, characters, estimatedCostUsd, costBasis } }) as VoicePlanView;
    expect(plansEstimate([plan(100, 0.01, 'ESTIMATED'), plan(200, 0.02, 'ESTIMATED')])).toEqual({ takes: 6, characters: 300, costUsd: 0.03, mock: false });
    expect(plansEstimate([plan(100, 0.01, 'ESTIMATED'), plan(200, null, 'UNPRICED')]).costUsd).toBeNull();
    expect(plansEstimate([plan(100, 0, 'MOCK'), plan(200, 0, 'MOCK')])).toMatchObject({ costUsd: 0, mock: true });
  });
});

describe('a comparison’s runs', () => {
  const run = (number: number, experiment: string | null, variant: string | null) => ({ number, experiment, variant });
  const runs = [run(1, null, null), run(2, 'X', 'A'), run(3, 'X', 'B'), run(4, 'X', 'A'), run(5, 'X', 'B'), run(6, 'Y', 'A'), run(7, null, null), run(8, 'X', 'A'), run(9, 'X', 'B'), run(10, 'X', 'C')].reverse();
  const numbers = (n: number) => experimentRuns(runs, n).map((r) => r.number);

  it('are one job’s consecutive runs of one name; a repeated label starts the next job', () => {
    expect(numbers(3)).toEqual([2, 3]);
    expect(numbers(4)).toEqual([4, 5]);
    expect(numbers(9)).toEqual([8, 9, 10]);
    expect(numbers(6)).toEqual([6]);
  });

  it('are none for a run outside any comparison', () => {
    expect(numbers(1)).toEqual([]);
    expect(numbers(7)).toEqual([]);
  });
});

/**
 * The engine's own wording (modules/voice config.ts and cost.ts), loaded when
 * the test runs: those modules reach the provider package, which the
 * dashboard's typecheck does not compile, so they are typed here by their
 * signatures.
 */
interface EngineWords {
  describeOverrides(o: VoiceConfigOverrides | null): string;
  configDifferences(a: EffectiveVoiceConfig, b: EffectiveVoiceConfig, form: 'RUN'): string[];
  costText(characters: number, reported: readonly { name: string; quantity: number }[]): string;
}
const modules = ['../../../modules/voice/src/config.ts', '../../../modules/voice/src/cost.ts'];
const engine = async (): Promise<EngineWords> => Object.assign({}, ...(await Promise.all(modules.map((m) => import(/* @vite-ignore */ m)))));

describe('costs', () => {
  it('read as the characters sent, with the provider’s own figure raw beside them (never as dollars)', () => {
    expect(costText(1577, [{ name: 'character-cost', quantity: 174 }])).toBe('sent 1,577 characters · provider reported 174 (character-cost header)');
    expect(costText(1, [])).toBe('sent 1 character · provider reported none');
    expect(costText(12345, [{ name: 'character-cost', quantity: 1200 }, { name: 'credits', quantity: 3 }])).toBe('sent 12,345 characters · provider reported 1,200 (character-cost header), 3 (credits header)');
  });

  it('say what the engine’s logs say, with the dashboard’s separator', async () => {
    const { costText: engineCostText } = await engine();
    for (const [n, r] of [[1577, [{ name: 'character-cost', quantity: 174 }]], [184, []], [1, [{ name: 'character-cost', quantity: 20 }]]] as const) expect(costText(n, r)).toBe(engineCostText(n, r).replace('; ', ' · '));
  });

  it('of a take: the estimate, its basis, and what was sent and reported', () => {
    const cost = { estimatedUsd: 0.12616, actualUsd: null, basis: 'ESTIMATED' as const, note: null, characters: 1577, reported: [{ name: 'character-cost', quantity: 174 }], reestimated: true };
    expect(takeCostText(cost)).toBe('~$0.1262 (estimated) · sent 1,577 characters · provider reported 174 (character-cost header)');
    expect(takeCostText({ ...cost, estimatedUsd: null, basis: null, characters: null, reported: [] })).toBe('unpriced');
    expect(takeCostText({ ...cost, actualUsd: 0, basis: 'MOCK', reported: [] })).toBe('$0.0000 (mock) · sent 1,577 characters · provider reported none');
  });
});

describe('provider settings in a form', () => {
  const d = (key: string, models: string[] | null, except?: string[]): VoiceSettingDescriptor => ({ key, label: key, help: '', kind: 'NUMBER', default: 0.5, min: 0, max: 1, models, ...(except ? { except } : {}), overridable: true });
  const settings = [d('warmth', null), d('breathy', ['studio-2', 'flash']), d('tempo', null, ['studio-3'])];

  it('say "not sent to {model}" by the model list, or by the exceptions when every model takes it', () => {
    expect(settings.map((x) => notSentTo(x, 'studio-2'))).toEqual([false, false, false]);
    expect(settings.map((x) => notSentTo(x, 'studio-3'))).toEqual([false, true, true]);
    // A model the provider does not know: every setting without a list, as the provider sends it.
    expect(settings.map((x) => notSentTo(x, 'next-model'))).toEqual([false, true, false]);
  });

  it('agree with the provider’s sentSettings for every ElevenLabs model and one it does not know', () => {
    const values = Object.fromEntries(ELEVENLABS_SETTINGS.map((x) => [x.key, x.default]));
    for (const model of [...Object.keys(ELEVENLABS_MODELS), 'eleven_next']) {
      const { ignored } = sentVoiceSettings(ELEVENLABS_SETTINGS, values, model);
      expect(ELEVENLABS_SETTINGS.filter((x) => notSentTo(x, model)).map((x) => x.key), model).toEqual(ignored);
    }
    expect(ELEVENLABS_SETTINGS.filter((x) => notSentTo(x, 'eleven_v4')).map((x) => x.key)).toEqual(['style', 'speakerBoost', 'speed']);
  });

  it('refuse a value outside the setting, never clamp it', () => {
    const choice: VoiceSettingDescriptor = { key: 'mood', label: 'Mood', help: '', kind: 'CHOICE', default: 'calm', choices: [{ value: 'calm', label: 'Calm' }, { value: 'warm', label: 'Warm' }], models: null, overridable: true };
    expect(settingProblem(settings[0]!, 0.4)).toBeNull();
    expect(settingProblem(settings[0]!, 1.2)).toBe('warmth: 0 to 1');
    expect(settingProblem(settings[0]!, Number.NaN)).toBe('warmth: a number');
    expect(settingProblem(choice, 'warm')).toBeNull();
    expect(settingProblem(choice, 'loud')).toBe('Mood: one of Calm, Warm');
  });
});

const effective = (over: Partial<EffectiveVoiceConfig> = {}): EffectiveVoiceConfig => ({
  ...structuredClone(DEFAULT_VOICE_PROFILE_CONFIG),
  providerSettings: { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 },
  provider: 'elevenlabs',
  voiceId: 'voice-1',
  model: 'eleven_v4',
  language: 'en',
  outputFormat: 'mp3_44100_128',
  ...over,
});

describe('a configuration and where each setting came from', () => {
  it('lists every setting with its source: the profile unless the project, the run or a take set it', () => {
    const c = effective({ strategy: 'EXPRESSIVE', providerSettings: { stability: 0.4, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 } });
    const rows = configRows(c, { 'providerSettings.stability': 'PROJECT', strategy: 'RUN', 'performanceRules.maxMarksPerChunk': 'TAKE' }, ELEVENLABS_SETTINGS, ['style', 'speakerBoost', 'speed']);
    const by = (path: string) => rows.find((r) => r.path === path)!;
    expect(by('providerSettings.stability')).toEqual({ path: 'providerSettings.stability', label: 'Stability', value: '0.4', source: 'PROJECT', note: null });
    expect(by('strategy')).toMatchObject({ value: 'Expressive moments', source: 'RUN' });
    expect(by('performanceRules.maxMarksPerChunk')).toMatchObject({ value: '2', source: 'TAKE' });
    expect(by('chunking')).toMatchObject({ value: '20–30 words (≈8–12 s)', source: 'PROFILE' });
    expect(by('context')).toMatchObject({ value: 'neighbouring text (200/120 chars)', source: 'PROFILE' });
    expect(by('performanceRules.paceSpeed').value).toBe('slow 0.94 · fast 1.06');
    expect(by('performanceRules.emotionWords').value).toBe('reflective: reflective · curious: curious · tense: tense · somber: somber · excited: excited');
    expect(by('performanceRules.deliveryWords').value).toBe('low energy: quiet · slow pace: deliberate · high energy: urgent · fast pace: brisk');
    expect(by('pronunciation').value).toBe("none (the project's approved list applies)");
    expect(rows.filter((r) => r.note).map((r) => [r.path, r.note])).toEqual([
      ['providerSettings.style', 'not sent to eleven_v4'],
      ['providerSettings.speakerBoost', 'not sent to eleven_v4'],
      ['providerSettings.speed', 'not sent to eleven_v4'],
    ]);
  });

  it('uses the descriptors for "not sent to" when the server does not say, and keeps a key no descriptor names', () => {
    const rows = configRows(effective({ model: 'eleven_v3', providerSettings: { stability: 0.5, similarity: 0.75, legacyKey: 'x' } }), {}, ELEVENLABS_SETTINGS);
    expect(rows.filter((r) => r.path.startsWith('providerSettings.')).map((r) => [r.label, r.value, r.note])).toEqual([
      ['Stability', '0.5', null],
      ['Similarity', '0.75', 'not sent to eleven_v3'],
      ['legacyKey', 'x', null],
    ]);
  });

  it('describes overrides as the engine does', async () => {
    const { describeOverrides: engineDescribe } = await engine();
    const cases: VoiceConfigOverrides[] = [
      {},
      { providerSettings: { stability: 0.4 } },
      { strategy: 'PLAIN' },
      { strategy: 'EXPRESSIVE', context: { previousChars: 0, nextChars: 0, stitch: false }, numberStyle: 'US', chunking: { minWords: 13, maxWords: 20 } },
      { performanceRules: { maxMarksPerChunk: 1, resetWord: 'plain', paceSpeed: { SLOW: 0.9, FAST: 1.1 }, emotionWords: { REFLECTIVE: null, CURIOUS: 'curious', TENSE: 'tense', SOMBER: 'somber', EXCITED: 'excited' } }, providerSettings: { stability: 0.3, speakerBoost: false } },
      { context: { previousChars: 200, nextChars: 120, stitch: true } },
    ];
    for (const o of cases) expect(describeOverrides(o), JSON.stringify(o)).toBe(engineDescribe(o));
    expect(describeOverrides({ providerSettings: { stability: 0.4 } })).toBe('stability 0.4');
    expect(describeOverrides({ strategy: 'EXPRESSIVE', providerSettings: { stability: 0.3 } })).toBe('performance expressive, stability 0.3');
    expect(describeOverrides(null)).toBe('none');
  });

  it('refuses overrides before they are sent: a take’s chunk size, settings the provider does not let be overridden, values out of range', () => {
    const fixed: VoiceSettingDescriptor = { key: 'warmth', label: 'Warmth', help: '', kind: 'NUMBER', default: 0.5, min: 0, max: 1, models: null, overridable: false };
    const settings = [...ELEVENLABS_SETTINGS, fixed];
    expect(overrideProblems({ providerSettings: { stability: 0.4 }, strategy: 'PLAIN' }, settings, 'PROJECT')).toEqual([]);
    expect(overrideProblems({ chunking: { minWords: 13, maxWords: 20 } }, settings, 'RUN')).toEqual([]);
    expect(overrideProblems({ chunking: { minWords: 13, maxWords: 20 } }, settings, 'TAKE')).toHaveLength(1);
    expect(overrideProblems({ providerSettings: { warmth: 0.2, stability: 1.4, tempo: 1 } }, settings, 'PROJECT')).toEqual(['Warmth: set on the profile only', 'Stability: 0 to 1', 'tempo: not a setting of this provider']);
    expect(overrideProblems({ chunking: { minWords: 30, maxWords: 20 } }, settings, 'PROJECT')).toEqual(['chunking.minWords: minWords must be below maxWords']);
  });

  it('reads a version as a configuration with no layers', () => {
    const c = effective();
    expect(versionEffective({ config: c, provider: 'elevenlabs', voiceId: 'voice-1', modelId: 'eleven_v4', language: 'en', outputFormat: 'mp3_44100_128' })).toEqual(c);
  });

  it('sends only what an editor set', () => {
    expect(pruneOverrides({ strategy: undefined, providerSettings: { stability: undefined }, performanceRules: {}, numberStyle: 'US' })).toEqual({ numberStyle: 'US' });
    expect(isEmptyOverrides({ providerSettings: {} })).toBe(true);
    expect(isEmptyOverrides({ providerSettings: { stability: 0.4 } })).toBe(false);
    expect(sameOverrides({ strategy: 'PLAIN', providerSettings: { speed: 1, stability: 0.4 } }, { providerSettings: { stability: 0.4, speed: 1 }, strategy: 'PLAIN', numberStyle: undefined })).toBe(true);
    expect(sameOverrides({ providerSettings: { stability: 0.4 } }, { providerSettings: { stability: 0.45 } })).toBe(false);
  });

  it('words a difference from the run as the engine does', async () => {
    const { configDifferences: engineDifferences } = await engine();
    const run = effective();
    const pairs: EffectiveVoiceConfig[] = [
      effective(),
      effective({ providerSettings: { ...run.providerSettings, stability: 0.4 } }),
      effective({ voiceId: 'voice-2', strategy: 'PLAIN', context: { previousChars: 0, nextChars: 0, stitch: false }, numberStyle: 'US' }),
      effective({ performanceRules: { ...run.performanceRules, maxMarksPerChunk: 1, paceSpeed: { SLOW: 0.9, FAST: 1.06 } } }),
      effective({ pronunciation: { rules: [{ term: 'Haarlem', method: 'ALIAS', pronunciation: 'Harlem' }, { term: 'Thijs', method: 'IPA', pronunciation: 'tɛis' }] } }),
    ];
    for (const b of pairs) expect(configDifferences(run, b)).toEqual(engineDifferences(run, b, 'RUN'));
    expect(configDifferences(run, pairs[1]!)).toEqual(['stability: 0.4 (run: 0.5)']);
    expect(configDifferences(run, pairs[4]!)).toEqual(['pronunciation rules: Haarlem (alias Harlem), Thijs (ipa tɛis) (run: none)']);
    // The same rules written with their keys in another order are the same rules.
    const reordered = effective({ pronunciation: { rules: [{ pronunciation: 'Harlem', method: 'ALIAS', term: 'Haarlem' } as never, { pronunciation: 'tɛis', term: 'Thijs', method: 'IPA' } as never] } });
    expect(configDifferences(pairs[4]!, reordered)).toEqual([]);
    expect(engineDifferences(pairs[4]!, reordered, 'RUN')).toEqual([]);
  });
});

describe('the production profile', () => {
  const profile = { name: 'Tulip narrator', version: 1 } as VoicePlanView['profile'];

  it('says how its version is chosen', () => {
    expect(productionMode({ mode: 'FOLLOW', profile, newer: null })).toBe('follows the current version');
    expect(productionMode({ mode: 'PIN', profile, newer: { id: 'x', version: 2 } })).toBe('pinned to v1 (v2 available)');
    expect(productionMode({ mode: 'PIN', profile, newer: null })).toBe('pinned to v1');
    expect(productionMode({ mode: 'DEFAULT', profile, newer: null })).toBe('library default');
  });

  it('is refused for a run’s chunks with its reason: a problem, another language or another output format', () => {
    const run = effective();
    expect(productionRefusal(run, { problem: null, effective: effective({ voiceId: 'other' }), profile })).toBeNull();
    expect(productionRefusal(run, { problem: 'Profile Tulip narrator v1 is for mock; the configured voice provider is elevenlabs', effective: null, profile: null })).toMatch(/is for mock/);
    expect(productionRefusal(run, { problem: null, effective: null, profile: null })).toMatch(/no production profile yet/);
    expect(productionRefusal(run, { problem: null, effective: effective({ language: 'es' }), profile })).toBe('The production profile Tulip narrator v1 is for es; this run is en');
    expect(productionRefusal(run, { problem: null, effective: effective({ outputFormat: 'wav_22050' }), profile })).toMatch(/^The production profile Tulip narrator v1 makes wav_22050 and this run is mp3_44100_128: clips of one run share a format/);
  });
});

describe('profiles and takes', () => {
  it('name a version, and its family’s name now after a rename', () => {
    expect(profileLabel({ name: 'Tulip narrator', version: 2, familyName: 'Tulip narrator' })).toBe('Tulip narrator v2');
    expect(profileLabel({ name: 'House narrator', version: 1, familyName: 'Classic narrator' })).toBe('House narrator v1 (now Classic narrator)');
    expect(profileLabel({ name: 'House narrator', version: 1, familyName: null })).toBe('House narrator v1');
  });

  it('say how a version was made', () => {
    expect(originText({ kind: 'RUN', runId: 'r', run: 3, projectId: 'p', project: 'tulip-mania', experiment: 'Acceptance experiment', variant: 'C expressive', takeId: null, reconstructed: true })).toBe(
      'saved from voice run 3 of tulip-mania (Acceptance experiment — C expressive), reconstructed from before saved profiles',
    );
    expect(originText({ kind: 'RUN', runId: 'r', run: 9, projectId: 'p', project: 'tulip-mania', experiment: null, variant: null, takeId: 't', reconstructed: false })).toBe('saved from a take of voice run 9 of tulip-mania');
    expect(originText({ kind: 'EDIT', basedOnVersion: 1 })).toBe('an edit of v1');
    expect(originText({ kind: 'DUPLICATE', fromFamily: 'House narrator', fromVersion: 2 })).toBe('a duplicate of House narrator v2');
    expect(originText({ kind: 'LEGACY' })).toBe('made before saved profiles');
  });

  it('label a take by what it was made with: nothing for the run’s configuration', () => {
    const ref = { familyId: null, familyName: 'Tulip narrator', versionId: '0', version: 2, name: 'Tulip narrator' };
    const take = (c: Partial<VoiceTakeConfigView>): VoiceTakeConfigView => ({ base: 'RUN', override: null, profile: ref, reconstructed: false, differs: [], identityDiffers: false, ...c });
    expect(takeLabels(take({}), null)).toEqual({ production: null, override: null, differs: null });
    expect(takeLabels(take({ base: 'PRODUCTION', differs: ['stability: 0.4 (run: 0.5)'] }), null)).toEqual({ production: 'production profile · Tulip narrator v2', override: null, differs: 'differs from the run: stability: 0.4 (run: 0.5)' });
    expect(takeLabels(take({ override: { strategy: 'PLAIN' }, differs: ['performance: plain (run: expressive)'] }), null)).toEqual({ production: null, override: 'temporary override · performance plain', differs: 'differs from the run: performance: plain (run: expressive)' });
    // An A/B take's strategy is its variant: no override label for it alone.
    expect(takeLabels(take({ override: { strategy: 'EXPRESSIVE' }, differs: ['performance: expressive (run: restrained)'] }), 'B expressive')).toEqual({ production: null, override: null, differs: null });
    expect(takeLabels(take({ override: { strategy: 'EXPRESSIVE', providerSettings: { stability: 0.3 } }, differs: ['performance: expressive (run: restrained)', 'stability: 0.3 (run: 0.5)'] }), 'B expressive')).toEqual({
      production: null,
      override: 'temporary override · stability 0.3',
      differs: 'differs from the run: stability: 0.3 (run: 0.5)',
    });
  });
});
