import {
  CHUNK_SECONDS,
  DEFAULT_VOICE_PROFILE_CONFIG,
  DirectorMark,
  PERFORMANCE_RULE_LABELS,
  PERFORMANCE_STRATEGY_LABELS,
  SCRIPT_TIMING,
  VOICE_PROFILE_ORIGIN_LABELS,
  VoiceConfigOverrides,
  VoiceTakeOverride,
  wordsForSeconds,
  type ChunkingSettings,
  type ConfigProvenance,
  type ConfigSource,
  type ContextSettings,
  type EffectiveVoiceConfig,
  type PerformanceRules,
  type VoiceChunkView,
  type VoiceCostView,
  type VoicePlanView,
  type VoiceProductionView,
  type ApproveAllTakesView,
  type VoiceProfileRef,
  type VoiceProfileView,
  type VoiceQaFinding,
  type VoiceQaKind,
  type VoiceRunSummaryView,
  type VoiceSettingDescriptor,
  type VoiceSettingValue,
  type VoiceTakeConfigView,
} from '@docengine/core';
import { formatUsd } from './format.ts';

/**
 * The Voice page's arithmetic, kept out of the components: chunk sizes in
 * seconds of speech, sentence numbers a director's direction addresses,
 * what a request would send and cost before it is confirmed, and how a
 * voice profile's configuration, its overrides and where each setting came
 * from read.
 */

const sized = (min: number, max: number) => ({ label: `≈${min}–${max} s`, chunking: { minWords: wordsForSeconds(min), maxWords: wordsForSeconds(max) } });
const { target, natural } = CHUNK_SECONDS;

/** Chunk sizes to choose or compare: below, at and above the target, within the natural range. */
export const CHUNK_SIZES: { label: string; chunking: ChunkingSettings }[] = [sized(natural.min, target.min), sized(target.min, target.max), sized(target.max, natural.max)];

export const NO_CONTEXT: ContextSettings = { previousChars: 0, nextChars: 0, stitch: false };
export const CONTEXTS: { label: string; context: ContextSettings }[] = [
  { label: 'Neighbouring text (a sentence or two)', context: DEFAULT_VOICE_PROFILE_CONFIG.context },
  { label: 'No context', context: NO_CONTEXT },
  { label: 'Stitched to the previous take (request ids)', context: { ...DEFAULT_VOICE_PROFILE_CONFIG.context, stitch: true } },
];

/** Seconds of speech for spoken words at the narration rate. */
export const secondsFor = (words: number) => (words * 60) / SCRIPT_TIMING.wordsPerMinute;

/** "20–30 words (≈8–12 s)" */
export const sizeLabel = (c: ChunkingSettings) => `${c.minWords}–${c.maxWords} words (≈${Math.round(secondsFor(c.minWords))}–${Math.round(secondsFor(c.maxWords))} s)`;

export const contextLabel = (c: ContextSettings) =>
  c.stitch ? 'stitched to the previous take' : c.previousChars || c.nextChars ? `neighbouring text (${c.previousChars}/${c.nextChars} chars)` : 'none';

/** Outside the range a natural thought may run to (worth a look, not an error). */
export const outsideNatural = (sec: number) => sec < natural.min || sec > natural.max;

// ── Sentences ────────────────────────────────────────────────────────────────

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set(
  'mr mrs ms dr st mt jr sr prof gen col capt lt sgt rev hon vs etc eg ie approx c ca no vol pp p fig ed eds inc ltd co corp dept est fl cf al'.split(' '),
);
const CLOSERS = `"'”’)]`;

/**
 * A chunk's sentences as character ranges, numbered as a director's
 * direction counts them. The same rule as the engine's sentence splitter
 * (modules/voice text.ts), which voice-plan.test.ts and the browser check compare it against: a
 * sentence ends at . ! ? or an ellipsis followed by a capital, a digit or an
 * opening quote — not after an abbreviation or an initial — and at a line
 * break (the break between two blocks).
 */
export function sentenceSpans(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = skipSpace(text, 0);
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      push(out, text, start, i);
      start = skipSpace(text, i + 1);
      i = start;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let end = i + 1;
      while (end < text.length && (text[end] === '.' || text[end] === '!' || text[end] === '?' || text[end] === '…')) end++;
      while (end < text.length && CLOSERS.includes(text[end]!)) end++;
      const next = skipSpace(text, end);
      if (next > end && next < text.length && isSentenceEnd(text, i, end, next)) {
        push(out, text, start, end);
        start = next;
        i = next;
        continue;
      }
      i = end;
      continue;
    }
    i++;
  }
  push(out, text, start, text.length);
  return out;
}

function isSentenceEnd(text: string, at: number, end: number, next: number): boolean {
  const following = text[next]!;
  if (/\p{Ll}/u.test(following)) return false;
  if (text[at] === '.' && end === at + 1) {
    const word = /([\p{L}]+)$/u.exec(text.slice(Math.max(0, at - 12), at))?.[1] ?? '';
    if (word.length === 1 && /\p{Lu}/u.test(word)) return false;
    if (ABBREVIATIONS.has(word.toLowerCase())) return false;
  }
  return /[\p{Lu}\p{N}"'“‘(\[]/u.test(following);
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function push(out: { start: number; end: number }[], text: string, start: number, end: number) {
  let e = end;
  while (e > start && /\s/.test(text[e - 1]!)) e--;
  if (e > start) out.push({ start, end: e });
}

export const sentencesOf = (text: string) => sentenceSpans(text).map((s) => text.slice(s.start, s.end));

/**
 * A director's directions typed one line per sentence, "sentence: emotion"
 * or "sentence: emotion, delivery", by the chunk's sentence numbers (1 to
 * `sentences`, each once). Null when a line does not read: the engine drops
 * a direction for a sentence the chunk does not have, so the take would be
 * paid for without it.
 */
export function parseDirections(text: string, sentences: number): DirectorMark[] | null {
  const marks: DirectorMark[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*:\s*([a-z][a-z \-']*)(?:,\s*([a-z][a-z \-']*))?$/.exec(line.toLowerCase());
    if (!m) return null;
    const sentence = Number(m[1]) - 1;
    if (sentence < 0 || sentence >= sentences || marks.some((x) => x.sentence === sentence)) return null;
    const mark = DirectorMark.safeParse({ sentence, emotion: m[2]!.trim(), ...(m[3] ? { delivery: m[3].trim() } : {}) });
    if (!mark.success) return null;
    marks.push(mark.data);
  }
  return marks;
}

// ── Estimates before a confirmation ──────────────────────────────────────────

export interface Estimate {
  takes: number;
  characters: number;
  /** null: no price known (unpriced, or nothing generated yet to price it from). */
  costUsd: number | null;
  mock: boolean;
}

/**
 * What new takes of these chunks would send and cost: each chunk's last
 * take sent this many characters (its text plus markup), priced at the
 * run's own rate. The server counts again when the request arrives.
 */
export function takesEstimate(chunks: readonly VoiceChunkView[], variants: number, run: Pick<VoiceRunSummaryView, 'characters'> & { cost: Pick<VoiceRunSummaryView['cost'], 'totalUsd' | 'basis'> }, mock: boolean): Estimate {
  const characters =
    variants *
    chunks.reduce((n, c) => {
      const last = c.current?.characters != null ? c.current : c.generations.find((g) => g.characters !== null);
      return n + (last?.characters ?? last?.performanceText?.length ?? c.text.length);
    }, 0);
  const rate = !mock && run.characters > 0 && run.cost.totalUsd > 0 ? run.cost.totalUsd / run.characters : null;
  return { takes: chunks.length * variants, characters, costUsd: mock ? 0 : rate === null ? null : rate * characters, mock };
}

/** The total of several plans (a comparison: every variant is generated in full). */
export function plansEstimate(plans: readonly VoicePlanView[]): Estimate {
  const mock = plans.every((p) => p.estimate.costBasis === 'MOCK');
  const priced = plans.every((p) => p.estimate.estimatedCostUsd !== null);
  return {
    takes: plans.reduce((n, p) => n + p.estimate.chunks, 0),
    characters: plans.reduce((n, p) => n + p.estimate.characters, 0),
    costUsd: mock ? 0 : priced ? plans.reduce((n, p) => n + p.estimate.estimatedCostUsd!, 0) : null,
    mock,
  };
}

export const costWords = (e: Pick<Estimate, 'costUsd' | 'mock'>) => (e.mock ? 'MOCK voice: no cost' : e.costUsd === null ? 'cost unknown (no price yet)' : `~$${e.costUsd < 0.01 ? e.costUsd.toFixed(4) : e.costUsd.toFixed(2)} estimated`);

// ── Comparisons ──────────────────────────────────────────────────────────────

/**
 * The runs one comparison job made, in variant order. A job numbers its
 * runs consecutively under one experiment name; a later job of the same
 * name starts its labels again, so a repeated label starts a new group.
 */
export function experimentRuns<R extends Pick<VoiceRunSummaryView, 'number' | 'experiment' | 'variant'>>(runs: readonly R[], number: number): R[] {
  let group: R[] = [];
  for (const r of [...runs].sort((a, b) => a.number - b.number)) {
    const last = group.at(-1);
    const joins = !!r.experiment && !!last && last.experiment === r.experiment && last.number === r.number - 1 && !group.some((g) => g.variant === r.variant);
    if (!joins) {
      if (group.some((g) => g.number === number)) break;
      group = r.experiment ? [r] : [];
    } else group.push(r);
  }
  return group.some((g) => g.number === number) ? group : [];
}

// ── Costs ────────────────────────────────────────────────────────────────────

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * "sent 1,577 characters · provider reported 174 (character-cost header)":
 * the characters sent are the estimate's basis; the provider's own figures
 * are shown raw under their name, never as dollars.
 */
export function costText(characters: number, reported: readonly { name: string; quantity: number }[]): string {
  const figures = reported.map((r) => `${thousands(r.quantity)} (${r.name} header)`).join(', ');
  return `sent ${thousands(characters)} character${characters === 1 ? '' : 's'} · provider reported ${figures || 'none'}`;
}

/** A take's cost: "~$0.0126 (estimated) · sent 157 characters · provider reported 17 (character-cost header)". */
export function takeCostText(c: VoiceCostView): string {
  const usd = c.actualUsd !== null ? formatUsd(c.actualUsd) : c.estimatedUsd !== null ? `~${formatUsd(c.estimatedUsd)}` : 'unpriced';
  return `${usd}${c.basis ? ` (${c.basis.toLowerCase()})` : ''}${c.characters !== null ? ` · ${costText(c.characters, c.reported)}` : ''}`;
}

// ── Voice profiles and configuration ─────────────────────────────────────────

/** "Tulip narrator v2", or "House narrator v1 (now Classic narrator)" after the profile was renamed. */
export const profileLabel = (ref: Pick<VoiceProfileRef, 'name' | 'version' | 'familyName'>) => `${ref.name} v${ref.version}${ref.familyName && ref.familyName !== ref.name ? ` (now ${ref.familyName})` : ''}`;

/** "{project title} narrator": the name offered when a run's configuration is saved. */
export const profileNameFor = (title: string) => `${title.replace(/\s+/g, ' ').trim().slice(0, 70)} narrator`;

/**
 * A model is not sent a setting: the form's rule, which agrees with the
 * provider's sentSettings for models it knows and for models it does not
 * (those are sent every setting not listed in `except`).
 */
export const notSentTo = (d: Pick<VoiceSettingDescriptor, 'models' | 'except'>, model: string) => (d.models ? !d.models.includes(model) : !!d.except?.includes(model));

/** Why a value does not fit its setting (never clamped: the form says so and the save waits). */
export function settingProblem(d: VoiceSettingDescriptor, v: VoiceSettingValue | undefined): string | null {
  if (v === undefined) return null;
  if (d.kind === 'NUMBER') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${d.label}: a number`;
    if ((d.min !== undefined && v < d.min) || (d.max !== undefined && v > d.max)) return `${d.label}: ${d.min ?? '…'} to ${d.max ?? '…'}`;
    return null;
  }
  if (d.kind === 'BOOLEAN') return typeof v === 'boolean' ? null : `${d.label}: on or off`;
  return typeof v === 'string' && (d.choices ?? []).some((c) => c.value === v) ? null : `${d.label}: one of ${(d.choices ?? []).map((c) => c.label).join(', ')}`;
}

const RULE_WORDS: Record<string, string> = {
  maxMarksPerChunk: 'directions per chunk',
  minWordsBetweenMarks: 'words between directions',
  directorWordsPerMark: "director's words per direction",
  resetWord: 'reset word',
  'paceSpeed.SLOW': 'slow pace speed',
  'paceSpeed.FAST': 'fast pace speed',
};
const ruleWord = (path: string) => RULE_WORDS[path] ?? (path.startsWith('emotionWords.') ? `word for ${path.slice(13).toLowerCase()}` : path.startsWith('deliveryWords.') ? `word for ${path.slice(14).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}` : path);
const shown = (v: unknown): string => (v === null || v === undefined ? 'none' : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** "previous 200 / next 120 chars", "none", "stitched" (as the engine's logs and labels write it). */
const contextText = (c: ContextSettings) => [c.previousChars || c.nextChars ? `previous ${c.previousChars} / next ${c.nextChars} chars` : c.stitch ? '' : 'none', c.stitch ? 'stitched' : ''].filter(Boolean).join(', ');
const flatRules = (r: Partial<PerformanceRules>): [string, unknown][] =>
  Object.entries(r).flatMap(([key, value]) => (value && typeof value === 'object' ? Object.entries(value).map(([k, v]) => [`${key}.${k}`, v] as [string, unknown]) : value === undefined ? [] : [[key, value] as [string, unknown]]));

/** "performance expressive, stability 0.3, context none", as the engine describes overrides in its logs; "none" when nothing is set. */
export function describeOverrides(o: VoiceConfigOverrides | null | undefined): string {
  if (!o) return 'none';
  const parts: string[] = [];
  if (o.strategy) parts.push(`performance ${o.strategy.toLowerCase()}`);
  if (o.chunking) parts.push(`chunk size ${o.chunking.minWords}–${o.chunking.maxWords} words`);
  if (o.context) parts.push(`context ${contextText(o.context)}`);
  if (o.numberStyle) parts.push(`number style ${o.numberStyle}`);
  for (const [path, value] of flatRules(o.performanceRules ?? {})) parts.push(`${ruleWord(path)} ${shown(value)}`);
  for (const [key, value] of Object.entries(o.providerSettings ?? {})) if (value !== undefined) parts.push(`${key} ${shown(value)}`);
  return parts.join(', ') || 'none';
}

/** Overrides as an editor holds them: a setting cleared in the form is undefined until they are sent. */
export type EditedOverrides = Omit<VoiceConfigOverrides, 'providerSettings'> & { providerSettings?: Record<string, VoiceSettingValue | undefined> };

/** Overrides with nothing left unset: no undefined values, and no empty rules or settings (what an editor sends). */
export function pruneOverrides(o: EditedOverrides): VoiceConfigOverrides {
  const out: VoiceConfigOverrides = {};
  for (const [key, value] of Object.entries(o) as [keyof VoiceConfigOverrides, unknown][]) {
    if (value === undefined) continue;
    if (key === 'performanceRules' || key === 'providerSettings') {
      const kept = Object.fromEntries(Object.entries(value as object).filter(([, v]) => v !== undefined));
      if (Object.keys(kept).length) (out as Record<string, unknown>)[key] = kept;
    } else (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export const isEmptyOverrides = (o: EditedOverrides | null | undefined) => !o || !Object.keys(pruneOverrides(o)).length;

/** JSON with every object's keys in order, so equal settings compare equal whatever order they were written in. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** The same overrides, whatever order their keys were set in (unset ones ignored). */
export const sameOverrides = (a: EditedOverrides, b: EditedOverrides) => stable(pruneOverrides(a)) === stable(pruneOverrides(b));

/**
 * Why overrides cannot be saved or sent, before the server is asked: values
 * the contract refuses (a take's chunk is its run's, so no chunk size), and
 * provider settings the provider does not describe, does not let be
 * overridden, or that do not fit.
 */
export function overrideProblems(o: EditedOverrides, settings: readonly VoiceSettingDescriptor[], scope: 'PROJECT' | 'RUN' | 'TAKE'): string[] {
  const pruned = pruneOverrides(o);
  const parsed = (scope === 'TAKE' ? VoiceTakeOverride : VoiceConfigOverrides).safeParse(pruned);
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || 'overrides'}: ${i.message}`);
  for (const [key, value] of Object.entries(pruned.providerSettings ?? {})) {
    const d = settings.find((x) => x.key === key);
    const problem = !d ? `${key}: not a setting of this provider` : !d.overridable ? `${d.label}: set on the profile only` : settingProblem(d, value);
    if (problem) problems.push(problem);
  }
  return problems;
}

/** A profile version as a configuration with no layers: its columns and config. */
export const versionEffective = (v: Pick<VoiceProfileView, 'config' | 'provider' | 'voiceId' | 'modelId' | 'language' | 'outputFormat'>): EffectiveVoiceConfig => ({
  ...v.config,
  provider: v.provider,
  voiceId: v.voiceId,
  model: v.modelId,
  language: v.language,
  outputFormat: v.outputFormat,
});

/** One row of a configuration table: a setting, its value, where it came from, and a note ("not sent to {model}"). */
export interface ConfigRow {
  path: string;
  label: string;
  value: string;
  source: ConfigSource;
  note: string | null;
}

/** "lowEnergy" → "low energy", "REFLECTIVE" → "reflective". */
const keyWords = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

const ruleValue = (key: keyof PerformanceRules, v: PerformanceRules[keyof PerformanceRules]) =>
  key === 'paceSpeed' ? `slow ${(v as PerformanceRules['paceSpeed']).SLOW} · fast ${(v as PerformanceRules['paceSpeed']).FAST}` : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${keyWords(k)}: ${x ?? 'none'}`).join(' · ') : String(v);

/**
 * A configuration as rows, each with where it came from (the profile unless
 * a project, run or take set it) and, for a provider setting the model does
 * not take, "not sent to {model}" (the server's `ignored` when it is known,
 * else the descriptors').
 */
export function configRows(c: EffectiveVoiceConfig, provenance: ConfigProvenance, descriptors: readonly VoiceSettingDescriptor[], ignored?: readonly string[]): ConfigRow[] {
  const row = (path: string, label: string, value: string, note: string | null = null): ConfigRow => ({ path, label, value, source: provenance[path] ?? 'PROFILE', note });
  const rules = c.pronunciation.rules;
  const keys = [...descriptors.map((d) => d.key).filter((k) => k in c.providerSettings), ...Object.keys(c.providerSettings).filter((k) => !descriptors.some((d) => d.key === k))];
  return [
    row('provider', 'Provider', c.provider),
    row('voiceId', 'Voice', c.voiceId),
    row('model', 'Model', c.model),
    row('language', 'Language', c.language),
    row('outputFormat', 'Output format', c.outputFormat),
    row('strategy', 'Performance', PERFORMANCE_STRATEGY_LABELS[c.strategy]),
    row('chunking', 'Chunk size', sizeLabel(c.chunking)),
    row('context', 'Continuity', contextLabel(c.context)),
    row('numberStyle', 'Number style', c.numberStyle === 'UK' ? 'UK ("one hundred and twenty")' : 'US ("one hundred twenty")'),
    row('pronunciation', 'Pronunciation rules', rules.length ? rules.map((r) => `${r.term} → ${r.pronunciation} (${r.method.toLowerCase()})`).join('; ') : "none (the project's approved list applies)"),
    ...(Object.keys(PERFORMANCE_RULE_LABELS) as (keyof PerformanceRules)[]).map((k) => row(`performanceRules.${k}`, PERFORMANCE_RULE_LABELS[k], ruleValue(k, c.performanceRules[k]))),
    ...keys.map((k) => {
      const d = descriptors.find((x) => x.key === k);
      const off = ignored ? ignored.includes(k) : !!d && notSentTo(d, c.model);
      return row(`providerSettings.${k}`, d?.label ?? k, shown(c.providerSettings[k]), off ? `not sent to ${c.model}` : null);
    }),
  ];
}

const chunkingText = (c: ChunkingSettings) => `${c.minWords}–${c.maxWords} words`;
/** "Haarlem (alias Harlem)", or "none" (as the engine writes a profile's rules). */
const rulesText = (r: EffectiveVoiceConfig['pronunciation']['rules']) => (r.length ? r.map((x) => `${x.term} (${x.method.toLowerCase()} ${x.pronunciation})`).join(', ') : 'none');

/**
 * What differs between two configurations, b against a, as the engine words
 * a take against its run: "stability: 0.4 (run: 0.5)". Empty when equal.
 */
export function configDifferences(a: EffectiveVoiceConfig, b: EffectiveVoiceConfig): string[] {
  const out: string[] = [];
  const add = (label: string, before: string, after: string) => {
    if (before !== after) out.push(`${label}: ${after} (run: ${before})`);
  };
  add('provider', a.provider, b.provider);
  add('voice', a.voiceId, b.voiceId);
  add('model', a.model, b.model);
  add('language', a.language, b.language);
  add('output format', a.outputFormat, b.outputFormat);
  add('performance', a.strategy.toLowerCase(), b.strategy.toLowerCase());
  add('chunk size', chunkingText(a.chunking), chunkingText(b.chunking));
  add('context', contextText(a.context), contextText(b.context));
  add('number style', a.numberStyle, b.numberStyle);
  if (stable(a.pronunciation.rules) !== stable(b.pronunciation.rules)) out.push(`pronunciation rules: ${rulesText(b.pronunciation.rules)} (run: ${rulesText(a.pronunciation.rules)})`);
  const before = new Map(flatRules(a.performanceRules));
  for (const [path, value] of flatRules(b.performanceRules)) add(ruleWord(path), shown(before.get(path)), shown(value));
  for (const key of new Set([...Object.keys(a.providerSettings), ...Object.keys(b.providerSettings)])) add(key, shown(a.providerSettings[key]), shown(b.providerSettings[key]));
  return out;
}

/**
 * Why a run's chunks cannot take the production profile now (null when they
 * can): a problem with it, another language, or another output format
 * (clips of one run share a format).
 */
export function productionRefusal(run: Pick<EffectiveVoiceConfig, 'language' | 'outputFormat'>, p: Pick<VoiceProductionView, 'problem' | 'effective' | 'profile'>): string | null {
  if (p.problem) return p.problem;
  if (!p.effective || !p.profile) return 'There is no production profile yet (it is made at the first plan)';
  const label = `${p.profile.name} v${p.profile.version}`;
  if (p.effective.language !== run.language) return `The production profile ${label} is for ${p.effective.language}; this run is ${run.language}`;
  if (p.effective.outputFormat !== run.outputFormat) return `The production profile ${label} makes ${p.effective.outputFormat} and this run is ${run.outputFormat}: clips of one run share a format — start a new run with the production profile`;
  return null;
}

/** How production's version is chosen: "follows the current version", "pinned to v1 (v2 available)", "library default". */
export function productionMode(p: Pick<VoiceProductionView, 'mode' | 'profile' | 'newer'>): string {
  if (p.mode === 'FOLLOW') return 'follows the current version';
  if (p.mode === 'PIN') return `pinned to v${p.profile?.version ?? '?'}${p.newer ? ` (v${p.newer.version} available)` : ''}`;
  return 'library default';
}

/** How a version was made: "saved from voice run 3 of tulip-mania (Acceptance experiment — C expressive)", "an edit of v1". */
export function originText(o: VoiceProfileView['origin']): string {
  switch (o.kind) {
    case 'EDIT':
      return `an edit of v${o.basedOnVersion}`;
    case 'DUPLICATE':
      return `a duplicate of ${o.fromFamily} v${o.fromVersion}`;
    case 'RUN':
      return `saved from ${o.takeId ? 'a take of ' : ''}voice run ${o.run} of ${o.project}${o.experiment ? ` (${o.experiment}${o.variant ? ` — ${o.variant}` : ''})` : ''}${o.reconstructed ? ', reconstructed from before saved profiles' : ''}`;
    default:
      return VOICE_PROFILE_ORIGIN_LABELS[o.kind];
  }
}

/**
 * A take's labels: the production profile it was made with, a temporary
 * override, and how it differs from its run. None for a take made with its
 * run's configuration. An A/B take's own strategy is its variant, not an
 * override worth a label.
 */
export function takeLabels(c: VoiceTakeConfigView, variant: string | null): { production: string | null; override: string | null; differs: string | null } {
  const override = c.override && variant ? { ...c.override, strategy: undefined } : c.override;
  const differs = variant ? c.differs.filter((d) => !d.startsWith('performance: ')) : c.differs;
  return {
    production: c.base === 'PRODUCTION' ? `production profile · ${profileLabel(c.profile)}` : null,
    override: isEmptyOverrides(override) ? null : `temporary override · ${describeOverrides(override)}`,
    differs: differs.length ? `differs from the run: ${differs.join('; ')}` : null,
  };
}

// ── Reviewing a run ──────────────────────────────────────────────────────────

/**
 * What "Approve all takes" did, in plain words: "Approved 11 takes", "All 11
 * takes were already approved", "Approved 9; 2 need a look first (blocking
 * findings on #4, #7)", then any already approved and the chunks with no
 * take to approve.
 */
export function approveAllText(r: ApproveAllTakesView): string {
  if (!r.approved && !r.skipped && !r.waiting.length) return !r.total ? 'This run has no takes yet' : r.total === 1 ? 'The take was already approved' : `All ${r.total} takes were already approved`;
  const parts = [
    r.skipped
      ? `${r.approved ? `Approved ${r.approved}` : 'None approved'}; ${r.skipped} need${r.skipped === 1 ? 's' : ''} a look first (blocking findings on ${r.blocked.join(', ')})`
      : r.approved
        ? `Approved ${r.approved} take${r.approved === 1 ? '' : 's'}`
        : 'No take was approved',
  ];
  if (r.alreadyApproved) parts.push(`${r.alreadyApproved} ${r.alreadyApproved === 1 ? 'was' : 'were'} already approved`);
  if (r.waiting.length) parts.push(`${r.waiting.length} ${r.waiting.length === 1 ? 'has' : 'have'} no take to approve yet (${r.waiting.join(', ')})`);
  return parts.join('; ');
}

/**
 * Findings about a run's narration as a whole, with what to do about each:
 * blocking, they stop it becoming the film's final narration (the VOICE
 * gate), never approving a take or storyboarding the run. Every other
 * finding is a take's (a take made with another voice is a warning: worth a
 * listen, it stops nothing).
 */
export const FINAL_NARRATION: Partial<Record<VoiceQaKind, string>> = {
  INCOMPLETE_NARRATION: 'Narrate the whole script',
  PRONUNCIATION_UNRESOLVED: 'Decide how names are said',
  STALE_SCRIPT: 'Narrate the current script',
  STALE_TEXT: 'The script changed under a chunk',
  ASSEMBLY_MISMATCH: 'Assemble the current takes',
  DUPLICATE_CHUNK: 'A part of the script is narrated twice',
  MISSING_CHUNK: 'A part of the script is not narrated',
};

/**
 * A run's findings in two kinds: its takes' — those still to review (a
 * count), what stops approving a take (blocking), what is worth a listen —
 * and the narration's as a whole (FINAL_NARRATION).
 */
export function splitFindings(qa: readonly VoiceQaFinding[]): { toReview: number; takes: VoiceQaFinding[]; checks: VoiceQaFinding[]; final: VoiceQaFinding[] } {
  const final = qa.filter((f) => f.kind in FINAL_NARRATION);
  const own = qa.filter((f) => !(f.kind in FINAL_NARRATION));
  return {
    toReview: own.filter((f) => f.kind === 'TAKE_UNREVIEWED').length,
    takes: own.filter((f) => f.severity === 'BLOCKING' && f.kind !== 'TAKE_UNREVIEWED'),
    checks: own.filter((f) => f.severity === 'WARNING'),
    final,
  };
}

/** What the final-narration findings do not stop, for the run shown. */
export function finalNote(r: Pick<VoiceRunSummaryView, 'kind' | 'stale'>): string {
  if (r.stale) return 'This run narrates an older version of the script: it can no longer be storyboarded.';
  if (r.kind === 'FULL') return "These stop this run being approved as the film's final narration; they do not stop approving takes or storyboarding it.";
  return `None of this stops approving takes or storyboarding this ${r.kind === 'AUDITION' ? 'audition' : 'run'}: it matters only for the film's final narration, a run of the whole script.`;
}

/** "Run 3 · C expressive · 0/11 approved · ★ your chosen run", as the run picker lists it. */
export function runOption(r: Pick<VoiceRunSummaryView, 'number' | 'label' | 'variant' | 'stale' | 'chunkCount' | 'takes'>, chosen: boolean): string {
  return [`Run ${r.number}`, r.variant ?? r.label, `${r.takes.APPROVED ?? 0}/${r.chunkCount} approved`, r.stale ? 'older script' : null, chosen ? '★ your chosen run' : null].filter(Boolean).join(' · ');
}
