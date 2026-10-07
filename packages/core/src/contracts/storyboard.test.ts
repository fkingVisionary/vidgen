import { describe, expect, it } from 'vitest';
import {
  GENERATED_VIDEO_METHODS,
  GENERATIVE_METHODS,
  METHOD_SOURCING,
  PRODUCTION_METHODS,
  SCRIPT_BLOCK_CLASSES,
  SOURCING_METHODS,
  STORYBOARD_STATUSES,
  ARTIFACT_STATUSES,
  VISUAL_INTENTS,
  VISUAL_TREATMENTS,
  type VisualTreatment,
} from '../enums.ts';
import { STORYBOARD_FINDING_LABELS, VISUAL_TREATMENT_HELP, VISUAL_TREATMENT_LABELS } from '../labels.ts';
import {
  ApprovalInput,
  GenerateStoryboardInput,
  RegenerateBeatsInput,
  ShotDecisionInput,
  StoryboardDecisionInput,
  StoryboardEditInput,
  VisualSelectionInput,
} from './api.ts';
import {
  ApproachSummary,
  AssetRequirement,
  BeatKey,
  ContinuitySpec,
  CostAlternative,
  CostBucket,
  CostRollup,
  CutPointId,
  DataRequirement,
  DEFAULT_REROLLS,
  DENSITY_TARGETS,
  DEPICTION_FOR,
  INTENT_TREATMENT_SEED,
  NarrationSpine,
  RECORD_TREATMENTS,
  SCOPE_END,
  SCOPE_START,
  SHOT_LIMITS,
  STORYBOARD_FINDING_KINDS,
  STORYBOARD_FINDING_SEVERITY,
  STORYBOARD_LIMITS,
  ShotEvidence,
  ShotKey,
  ShotSpec,
  ShotSubjectDetail,
  ShotTiming,
  StoryboardContent,
  StoryboardEditOp,
  StoryboardJobInput,
  StoryboardQaFinding,
  SubjectKey,
  TREATMENT_CLASS_RULES,
  TREATMENT_METHODS,
  VisualBeatContent,
  VisualCostEstimate,
  beatKey,
  cutPointId,
  depictionFor,
  narrationFingerprintText,
  parseCutPointId,
  seedTreatment,
  shotKey,
  subjectKey,
  treatmentsFor,
  type DepictionFacts,
} from './storyboard.ts';
import { VisualPricingSnapshot } from './visual-catalog.ts';
import {
  DEFAULT_VISUAL_PRESET,
  DEFAULT_VISUAL_PROFILE_CONFIG,
  VISUAL_PROFILE_PRESETS,
  VisualConfigOverrides,
  VisualProfileOrigin,
  VisualProfileSnapshot,
  VisualStyleProfileConfig,
} from './visual-profile.ts';

const id = (n: number) => `0190f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FINGERPRINT = 'a'.repeat(64);

const timing = (over: Record<string, unknown> = {}) => ({
  narration: { from: '1.1:0', to: '1.1:12' },
  narrationStartMs: 0,
  narrationEndMs: 4200,
  leadInMs: 0,
  tailOutMs: 0,
  bridge: null,
  visualFrom: null,
  visualTo: null,
  silenceAt: null,
  cutIn: 'SCOPE_EDGE',
  cutOut: 'SENTENCE_END',
  audio: [{ chunkId: id(1), generationId: id(2), audioAssetId: id(3) }],
  unalignedTake: false,
  ...over,
});

const spec = (over: Record<string, unknown> = {}) => ({
  purpose: 'Place the viewer on the quay before the fire',
  description: 'A wide view of a timber quay at dusk, barrels stacked under tarred canvas, lanterns being lit.',
  composition: 'Wide, quay on the left third, water to the right',
  shotType: 'WIDE',
  camera: { angle: 'eye level', lens: '35mm' },
  movement: { motion: 'PUSH_IN', intensity: 'LOW', note: 'slow push towards the warehouses' },
  environment: { subjectKey: 'CS01', description: 'The harbour quay, period timber warehouses' },
  objects: [{ name: 'tar barrels', basis: 'CLAIM', claimKeys: ['C003'] }],
  lighting: 'Last daylight, lanterns',
  mood: 'Quiet before the disaster',
  transitionIn: 'CUT',
  transitionOut: 'DISSOLVE',
  continuity: { subjectKeys: ['CS01'], notes: ['Same warehouses as SH004'] },
  mustShow: [{ detail: 'Tar barrels stored on the quay', claimKeys: ['C003'], origin: 'SCRIPT' }],
  mustAvoid: [{ text: 'modern cranes', origin: 'SEQUENCE' }],
  specifics: [{ detail: 'Timber warehouses with gabled fronts', kind: 'ARCHITECTURE', basis: 'PERIOD_GENERIC', claimKeys: [] }],
  overlays: [{ kind: 'DATE_STAMP', text: '14 May 1782', reason: 'The date is documented', claimKeys: ['C001'], auto: false }],
  uncertaintyDevice: 'NONE',
  dataSpec: null,
  depiction: 'RECONSTRUCTED',
  styleOverrides: { filmGrain: 'MEDIUM' },
  notes: [],
  ...over,
});

const asset = (over: Record<string, unknown> = {}) => ({
  assetType: 'VIDEO_CLIP',
  method: 'GENERATIVE_VIDEO',
  sourcing: 'GENERATE',
  durationSec: 8.4,
  aspectRatio: '16:9',
  resolution: '1080p',
  references: [{ subjectKey: 'CS01', status: 'MISSING' }],
  licensing: { status: 'NOT_APPLICABLE', note: '' },
  reuse: {
    reusable: true,
    reuseKey: 'env:harbour-quay:1782:cinematic-history@1',
    category: 'ENVIRONMENT',
    subjects: ['CS01'],
    location: 'Corvel harbour',
    era: '1780s',
    style: { profileId: id(20), version: 1 },
    claimKeys: ['C003'],
    projectId: id(30),
    provider: 'acme-video',
    model: 'acme-video-2',
    source: null,
    promptVersion: null,
  },
  reuseOf: null,
  ...over,
});

const cost = (over: Record<string, unknown> = {}) => ({
  method: 'GENERATIVE_VIDEO',
  provider: 'acme-video',
  model: 'acme-video-2',
  source: 'ROUTER',
  lines: [
    {
      what: 'video',
      usage: [{ unit: 'VIDEO_SECONDS', quantity: 8 }],
      rate: { unit: 'VIDEO_SECONDS', usdPerUnit: 0.1125, source: 'acme.example/pricing (checked 2026-10-07)', checkedAt: '2026-10-07', confidence: 'ASSUMPTION' },
    },
  ],
  perGenerationUsd: 0.9,
  rerollAllowance: 1.5,
  generations: 2.5,
  totalUsd: 2.25,
  basis: 'ESTIMATED',
  durationSource: 'AUDIO',
  billedClipSec: 8,
  note: '8 s × $0.1125/s × 2.5 generations (acme.example/pricing, checked 2026-10-07; ASSUMPTION)',
  generationSec: 8,
  confidence: 'ASSUMPTION',
  candidates: [{ provider: 'acme-video', model: 'acme-video-2', totalUsd: 2.25, basis: 'ESTIMATED' }],
  ...over,
});

const beatContent = (over: Record<string, unknown> = {}) => ({
  title: 'The quay before the fire',
  purpose: 'Establish the harbour and its stores',
  concept: 'An ordinary evening that the viewer knows will end in fire',
  informationCommunicated: ['Tar and timber were stored together on the quay'],
  narrativePurpose: 'Set the stakes',
  functions: ['ORIENTATION'],
  evidenceRelationship: 'DEPICTS_EVIDENCE',
  importance: 'HIGH',
  complexity: 'MEDIUM',
  continuity: { subjectKeys: ['CS01'], notes: [] },
  narration: { from: SCOPE_START, to: '1.2:end' },
  approach: 'C',
  options: {
    A: { treatment: 'CINEMATIC_RECONSTRUCTION', concept: 'Generated dusk on the quay' },
    B: { treatment: 'ARCHIVAL_IMAGE', concept: 'A period print of the harbour' },
    C: { treatment: 'CINEMATIC_RECONSTRUCTION', concept: 'Generated dusk, then the print' },
  },
  ...over,
});

const continuity = (over: Record<string, unknown> = {}) => ({
  name: 'Mira',
  kind: 'CHARACTER',
  castId: 'F1',
  castKind: 'FICTIONAL_COMPOSITE',
  basis: 'FICTION',
  anonymous: false,
  description: 'A dock worker standing for the harbour labourers of the 1780s',
  era: '1780s',
  location: 'Corvel harbour',
  approximateAge: 'about 30',
  clothing: 'Wool skirt, apron, headscarf',
  physicalDescription: 'Weathered hands',
  visualIdentity: { palette: ['brown', 'grey'], silhouette: 'Shawl over the shoulders', props: ['rope hook'] },
  designDetails: [{ detail: 'Rope hook at the belt', basis: 'INVENTED', claimKeys: [] }],
  rules: ['Observes, never interacts with real people'],
  claimKeys: ['C010'],
  referenceAsset: { required: true, status: 'MISSING', note: 'Requires Mira continuity asset' },
  ...over,
});

const preset = VISUAL_PROFILE_PRESETS[0]!;

const content = () => ({
  engineVersion: 1,
  inputs: {
    script: { id: id(40), version: 5 },
    architecture: { id: id(41), version: 3, dossierId: id(42) },
    narration: {
      runId: id(43),
      runNumber: 3,
      runKind: 'AUDITION',
      assemblyId: id(44),
      assemblyVersion: 1,
      fingerprint: FINGERPRINT,
      languageVersionId: id(45),
      language: 'en',
      totalDurationMs: 109_800,
      complete: false,
      voiceProfileId: id(46),
      takes: [{ id: id(2), chunkIndex: 0, status: 'IN_REVIEW', mock: false }],
      approval: 'UNREVIEWED',
    },
    profile: {
      mode: 'DEFAULT',
      revision: 0,
      familyId: id(47),
      familyName: preset.name,
      profileId: id(20),
      name: preset.name,
      version: 1,
      overrides: {},
      effective: preset.config,
      provenance: {},
    },
    pricing: { catalogVersion: '2026-10-07.1', cards: [] },
    candidates: [{ id: id(48), key: 'S01', timePeriod: '1780s', setting: 'A northern harbour', visualEnvironment: null }],
  },
  provenance: { origin: 'GENERATED', baseVersion: null, baseId: null, approach: 'C', beatKeys: [], ops: [], note: null, requestedBy: 'editor', jobId: id(49), models: { beats: 'model-a' }, promptVersion: 'storyboard-1' },
  scope: { kind: 'PARTIAL', blockKeys: ['1.1', '1.2'], sectionKeys: ['SC01'], startMs: 0, endMs: 109_800, outOfScopeBlocks: 120 },
  approaches: {
    chosen: 'C',
    options: [{ approach: 'C', treatmentMix: { CINEMATIC_RECONSTRUCTION: 60_000, ARCHIVAL_IMAGE: 49_800 }, generatedVideoShare: 0.55, estimatedShots: 18, estimatedCostUsd: 22.5, costBasis: 'MIXED', unpricedShots: 3, evidenceShare: 0.4, replacedOptions: 0 }],
  },
  alternatives: [
    {
      id: 'alt-1',
      title: 'Replace 5 cinematic video shots in section 1 with animated stills',
      shotKeys: ['SH001', 'SH002'],
      from: { treatment: 'CINEMATIC_RECONSTRUCTION', method: 'GENERATIVE_VIDEO' },
      to: { treatment: 'GENERATED_STILL', method: 'STILL_MOTION' },
      beforeUsd: 34,
      afterUsd: 11,
      savingUsd: 23,
      basis: 'ESTIMATED',
      tradeoff: 'Less movement',
    },
  ],
  rhythm: {
    shots: 18,
    averageShotMs: 6100,
    medianShotMs: 5800,
    minShotMs: 1900,
    maxShotMs: 11_200,
    cutsPerMinute: 9.3,
    treatmentChanges: 9,
    longestSameTreatmentRun: 3,
    staticShare: 0.2,
    movingShare: 0.8,
    claimsPerMinute: 6,
    overlaysPerMinute: 1.5,
    resetPoints: [{ atMs: 0, kind: 'SECTION', ref: 'SC01' }],
    peaks: [{ atMs: 52_000, beatKey: 'VB04', kind: 'REVEAL' }],
    reveals: 1,
    transitions: 2,
    generatedVideoShare: 0.55,
  },
  costs: {
    totalUsd: 22.5,
    basis: 'MIXED',
    unpricedShots: 3,
    byTreatment: [{ key: 'CINEMATIC_RECONSTRUCTION', shots: 9, totalUsd: 22.5, unpricedShots: 0, basis: 'ESTIMATED' }],
    byMethod: [],
    byProvider: [],
    byModel: [],
    bySection: [],
    byBeat: [],
    perFinishedMinute: 12.3,
  },
  evidenceCoverage: { factualShots: 10, traced: 8, untraced: ['SH007', 'SH011'] },
  changes: null,
  normalization: ['SH003: lead-in at 1.2:4 dropped (outside the neighbour\'s narration)'],
  notes: [],
});

const spine = () => ({
  assembly: { id: id(44), runId: id(43), version: 1, status: 'IN_REVIEW', complete: false, totalDurationMs: 9000, fingerprint: FINGERPRINT, profileId: id(46), scriptId: id(40), languageVersionId: id(45) },
  run: { id: id(43), number: 3, kind: 'AUDITION', scopeBlockKeys: ['1.1', '1.2'] },
  entries: [{ chunkId: id(1), chunkIndex: 0, generationId: id(2), generation: 1, audioAssetId: id(3), sectionKey: 'SC01', blockKeys: ['1.1', '1.2'], startMs: 0, endMs: 9000, gapAfterMs: 0 }],
  chunks: [{ id: id(1), index: 0, sectionKey: 'SC01', spans: [{ blockId: id(50), blockKey: '1.1', start: 0, end: 20 }, { blockId: id(51), blockKey: '1.2', start: 0, end: 15 }], sourceText: 'The quay was quiet.\nThen came the fire.' }],
  takes: [{ id: id(2), chunkId: id(1), status: 'IN_REVIEW', durationMs: 9000, alignment: { source: 'PROVIDER', words: [{ word: 'The', start: 0, end: 3, startMs: 100, endMs: 300 }], characters: null, unmatchedWords: 0 }, audioAssetId: id(3), mock: false, qaBlocking: false }],
  timeline: [],
});

describe('storyboard keys and cut points', () => {
  it('formats and checks lineage keys', () => {
    expect([beatKey(7), shotKey(23), subjectKey(3)]).toEqual(['VB07', 'SH023', 'CS03']);
    expect([beatKey(120), shotKey(1234)]).toEqual(['VB120', 'SH1234']);
    for (const [schema, good, bad] of [
      [BeatKey, 'VB07', 'VB7'],
      [ShotKey, 'SH023', 'SH23'],
      [SubjectKey, 'CS03', 'C03'],
    ] as const) {
      expect(schema.safeParse(good).success, good).toBe(true);
      expect(schema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('names cut points by block and word, never by time', () => {
    for (const ok of ['1.3:0', '1.3:12', '1.3:end', SCOPE_START, SCOPE_END, 'SC01-B01:4', cutPointId('2.10', 'end')]) expect(CutPointId.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['1.3', '1.3:-1', '1.3:abc', 'a b:3', '1.3:4.5', '4200', '1.3:end ', '']) expect(CutPointId.safeParse(bad).success, bad).toBe(false);
    // One spelling per point: "1.3:07" would be the same point as "1.3:7" under another ID.
    for (const bad of ['1.3:07', '1.3:00', `${SCOPE_START}:3`, `1.3${SCOPE_END}:end`]) expect(CutPointId.safeParse(bad).success, bad).toBe(false);
    expect(CutPointId.safeParse('1.3:70').success).toBe(true);
    expect(parseCutPointId('1.3:12')).toEqual({ blockKey: '1.3', word: 12 });
    expect(parseCutPointId('1.3:end')).toEqual({ blockKey: '1.3', word: 'end' });
    expect(parseCutPointId(SCOPE_START)).toEqual({ edge: 'START' });
    expect(parseCutPointId(SCOPE_END)).toEqual({ edge: 'END' });
    expect(parseCutPointId('12.5 s')).toBeNull();
  });
});

describe('ShotTiming', () => {
  it('round-trips a narrated shot and a silence-only shot', () => {
    expect(ShotTiming.parse(timing())).toEqual(timing());
    const silence = timing({ narration: null, narrationStartMs: null, narrationEndMs: null, silenceAt: '1.2:end', bridge: { kind: 'SILENCE', fromBlockId: id(50), toBlockId: id(51) }, cutIn: 'PAUSE', cutOut: 'PAUSE' });
    expect(ShotTiming.parse(silence)).toEqual(silence);
    const lead = timing({ visualFrom: '1.1:9', leadInMs: 640 });
    expect(ShotTiming.parse(lead).leadInMs).toBe(640);
  });

  it('refuses a shot with no anchor, with both anchors, or with times that do not go with its anchor', () => {
    expect(ShotTiming.safeParse(timing({ narration: null, narrationStartMs: null, narrationEndMs: null })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ silenceAt: '1.1:end' })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ narrationStartMs: null, narrationEndMs: null })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ narration: null, silenceAt: '1.1:end' })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ narrationStartMs: 5000, narrationEndMs: 4000 })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ narration: null, narrationStartMs: null, narrationEndMs: null, silenceAt: '1.1:end', visualFrom: '1.1:3' })).success).toBe(false);
    // A narrated shot has both its narration times, never one.
    expect(ShotTiming.safeParse(timing({ narrationEndMs: null })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ narrationStartMs: null })).success).toBe(false);
  });

  it('makes a silence-only shot an explicit bridge with no lead-in or tail-out', () => {
    const silence = { narration: null, narrationStartMs: null, narrationEndMs: null, silenceAt: '1.2:end', bridge: { kind: 'SILENCE', fromBlockId: id(50), toBlockId: id(51) } };
    expect(ShotTiming.safeParse(timing(silence)).success).toBe(true);
    expect(ShotTiming.safeParse(timing({ ...silence, bridge: null })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ ...silence, leadInMs: 300 })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ ...silence, tailOutMs: 300 })).success).toBe(false);
  });

  it('takes lead-ins and tail-outs only as cut points, and only whole, non-negative milliseconds', () => {
    expect(ShotTiming.safeParse(timing({ visualFrom: '850' })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ leadInMs: -1 })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ leadInMs: 12.5 })).success).toBe(false);
    expect(ShotTiming.safeParse(timing({ cutIn: 'FIVE_SECONDS' })).success).toBe(false);
  });
});

describe('ShotSpec and its parts', () => {
  it('round-trips a full shot specification, subject detail, evidence, asset requirement and cost', () => {
    expect(ShotSpec.parse(spec())).toEqual(spec());
    const detail = { role: 'PRIMARY', action: 'lights a lantern', interactions: [{ withSubjectKey: 'CS02', kind: 'OBSERVES' }], likeness: 'PERIOD_GENERIC', speaks: null };
    expect(ShotSubjectDetail.parse(detail)).toEqual(detail);
    const evidence = {
      claims: [{ claimId: id(60), claimKey: 'C003', role: 'DEPICTS', verdict: 'ESTABLISHED', confidence: 'HIGH', presentation: null, sourceIds: [id(61)] }],
      narrationClasses: ['DOCUMENTED'],
      beatBases: ['DOCUMENTED'],
      archBeatIds: ['1.2'],
      sequenceNumber: 1,
      settingBasis: { location: 'DOCUMENTED', date: 'DOCUMENTED', timeOfDay: 'RECONSTRUCTION' },
    };
    expect(ShotEvidence.parse(evidence)).toEqual(evidence);
    expect(AssetRequirement.parse(asset())).toEqual(asset());
    expect(VisualCostEstimate.parse(cost())).toEqual(cost());
  });

  it('refuses an unknown treatment, depiction or enum value', () => {
    expect(ShotSpec.safeParse(spec({ depiction: 'FOOTAGE' })).success).toBe(false);
    expect(ShotSpec.safeParse(spec({ uncertaintyDevice: 'TRUST_ME' })).success).toBe(false);
    expect(AssetRequirement.safeParse(asset({ method: 'VENDOR_VIDEO' })).success).toBe(false);
    expect(VisualBeatContent.safeParse(beatContent({ options: { ...beatContent().options, B: { treatment: 'STOCK_PHOTO', concept: 'x' } } })).success).toBe(false);
    expect(StoryboardEditOp.safeParse({ op: 'setTreatment', shotKey: 'SH001', treatment: 'HOLOGRAM' }).success).toBe(false);
  });

  it('bounds every string and list a model or an editor writes', () => {
    expect(ShotSpec.safeParse(spec({ description: 'x'.repeat(STORYBOARD_LIMITS.description) })).success).toBe(true);
    expect(ShotSpec.safeParse(spec({ description: 'x'.repeat(STORYBOARD_LIMITS.description + 1) })).success).toBe(false);
    expect(ShotSpec.safeParse(spec({ purpose: 'x'.repeat(STORYBOARD_LIMITS.field + 1) })).success).toBe(false);
    const specific = { detail: 'a uniform', kind: 'UNIFORM', basis: 'INVENTED', claimKeys: [] };
    expect(ShotSpec.safeParse(spec({ specifics: Array(STORYBOARD_LIMITS.specifics + 1).fill(specific) })).success).toBe(false);
    const overlay = { kind: 'CAPTION', text: 'x', reason: 'y', claimKeys: [], auto: false };
    expect(ShotSpec.safeParse(spec({ overlays: Array(STORYBOARD_LIMITS.overlays + 2).fill(overlay) })).success).toBe(true);
    expect(ShotSpec.safeParse(spec({ overlays: Array(STORYBOARD_LIMITS.overlays + 3).fill(overlay) })).success).toBe(false);
    expect(ShotSpec.safeParse(spec({ notes: Array(STORYBOARD_LIMITS.notes + 1).fill('note') })).success).toBe(false);
    expect(VisualBeatContent.safeParse(beatContent({ title: 'x'.repeat(STORYBOARD_LIMITS.title + 1) })).success).toBe(false);
  });

  it('keeps a data requirement to labels, figures as written, dates, places and claim keys: no coordinates, no free payload', () => {
    const data = { chartType: 'BAR_CHART', title: 'Funding raised, 2014–2018', items: [{ label: 'Series B', figure: '$40M', date: '2016', place: null, claimKey: 'C014' }], note: 'Amounts as reported in the filings' };
    expect(DataRequirement.parse(data)).toEqual(data);
    expect(ShotSpec.parse(spec({ dataSpec: data, depiction: 'DATA' })).dataSpec).toEqual(data);
    expect(DataRequirement.safeParse({ ...data, series: [1, 2, 3] }).success).toBe(false);
    expect(DataRequirement.safeParse({ ...data, items: [{ ...data.items[0], lat: 52.3, lon: 4.9 }] }).success).toBe(false);
    expect(DataRequirement.safeParse({ ...data, items: [] }).success).toBe(false);
    expect(DataRequirement.safeParse({ ...data, items: Array(25).fill(data.items[0]) }).success).toBe(false);
    expect(DataRequirement.safeParse({ ...data, items: [{ ...data.items[0], figure: 40_000_000 }] }).success).toBe(false);
  });

  it('never prices an unpriced estimate at $0', () => {
    const unpriced = cost({ basis: 'UNPRICED', totalUsd: null, perGenerationUsd: null, confidence: null, lines: [{ what: 'archival item', usage: [{ unit: 'REQUESTS', quantity: 1 }], rate: null }], note: 'No price configured for archival sourcing' });
    expect(VisualCostEstimate.parse(unpriced).totalUsd).toBeNull();
    expect(VisualCostEstimate.safeParse({ ...unpriced, totalUsd: 0 }).success).toBe(false);
    expect(VisualCostEstimate.safeParse(cost({ totalUsd: null })).success).toBe(false);
    expect(VisualCostEstimate.safeParse({ ...unpriced, confidence: 'ASSUMPTION' }).success).toBe(false);
    expect(VisualCostEstimate.safeParse(cost({ basis: 'VENDOR_REPORTED' })).success).toBe(false);
    expect(VisualCostEstimate.safeParse(cost({ durationSource: 'WORDS' })).success).toBe(false);
    expect(VisualCostEstimate.safeParse(cost({ generations: 0.5 })).success).toBe(false);
    expect(VisualCostEstimate.safeParse({ ...unpriced, perGenerationUsd: 0 }).success).toBe(false);
  });

  it('prices an estimate only when every line has a rate with a source, a check date and a confidence', () => {
    const line = cost().lines[0]!;
    const rated = (rate: Record<string, unknown>) => cost({ lines: [{ ...line, rate: { ...line.rate, ...rate } }] });
    expect(VisualCostEstimate.safeParse(rated({ source: '' })).success).toBe(false);
    expect(VisualCostEstimate.safeParse(rated({ source: '   ' })).success).toBe(false);
    expect(VisualCostEstimate.safeParse(rated({ checkedAt: '' })).success).toBe(false);
    expect(VisualCostEstimate.safeParse(rated({ checkedAt: 'October 2026' })).success).toBe(false);
    // IMAGE_TO_VIDEO with the still priced and the video not: the whole estimate is UNPRICED, never a partial total.
    const twoLines = [line, { what: 'video', usage: [{ unit: 'VIDEO_SECONDS', quantity: 8 }], rate: null }];
    expect(VisualCostEstimate.safeParse(cost({ method: 'IMAGE_TO_VIDEO', lines: twoLines })).success).toBe(false);
    expect(VisualCostEstimate.safeParse(cost({ method: 'IMAGE_TO_VIDEO', lines: twoLines, basis: 'UNPRICED', totalUsd: null, perGenerationUsd: null, confidence: null })).success).toBe(true);
    expect(VisualCostEstimate.safeParse(cost({ confidence: null })).success).toBe(false);
    // A reused asset is counted once: the reusing shot has no line of its own.
    expect(VisualCostEstimate.safeParse(cost({ lines: [], perGenerationUsd: 0, totalUsd: 0, confidence: null, generationSec: 0, note: 'Reuses SH004 (counted once)' })).success).toBe(true);
  });
});

describe('beats, continuity and QA findings', () => {
  it('round-trips a visual beat with its three approach options, and a continuity subject', () => {
    expect(VisualBeatContent.parse(beatContent())).toEqual(beatContent());
    expect(ContinuitySpec.parse(continuity())).toEqual(continuity());
    expect(ContinuitySpec.safeParse(continuity({ referenceAsset: { required: true, status: 'APPROVED', note: '' } })).success).toBe(false);
    expect(VisualBeatContent.safeParse(beatContent({ options: { A: beatContent().options.A, B: beatContent().options.B } })).success).toBe(false);
  });

  it('has the shape of a voice finding, and a severity for every kind', () => {
    const f = { kind: 'EVIDENCE_MISSING', severity: 'BLOCKING', ref: 'SH007', detail: 'No traceable source for C014' };
    expect(StoryboardQaFinding.parse(f)).toEqual(f);
    expect(StoryboardQaFinding.safeParse({ ...f, kind: 'LOOKS_WRONG' }).success).toBe(false);
    expect(StoryboardQaFinding.safeParse({ ...f, severity: 'INFO' }).success).toBe(false);
    for (const k of STORYBOARD_FINDING_KINDS) expect(STORYBOARD_FINDING_LABELS[k], k).toBeTruthy();
    const blocking = STORYBOARD_FINDING_KINDS.filter((k) => STORYBOARD_FINDING_SEVERITY[k] === 'BLOCKING');
    expect(blocking).toEqual(expect.arrayContaining(['NARRATION_UNMAPPED', 'TIMELINE_GAP', 'SHOT_OVERLAP', 'EVIDENCE_MISSING', 'UNCERTAIN_AS_FACT', 'GENERATED_RECORD', 'REAL_LIKENESS', 'FICTION_IN_DOCUMENTED', 'DEVICE_UNREALIZED', 'SHOT_UNPLANNED', 'MOCK_NARRATION', 'STALE_NARRATION', 'STALE_VERDICT', 'SCOPE_INCOMPLETE']));
    for (const k of ['TREATMENT_REPETITION', 'COST_UNPRICED', 'PROVISIONAL_TIMING', 'UNALIGNED_TAKE', 'MODEL_REFERENCE_DROPPED', 'ANACHRONISM_RISK', 'SCOPE_PARTIAL', 'STALE_PRICING'] as const) {
      expect(STORYBOARD_FINDING_SEVERITY[k], k).toBe('WARNING');
    }
  });
});

describe('StoryboardContent', () => {
  it('round-trips a version with frozen inputs, provenance, approaches, alternatives, rhythm and costs', () => {
    expect(StoryboardContent.parse(content())).toEqual(content());
    expect(VisualProfileSnapshot.parse(content().inputs.profile)).toEqual(content().inputs.profile);
  });

  it('records edit operations in its provenance, and only valid ones', () => {
    const edited = { ...content(), provenance: { ...content().provenance, origin: 'EDIT', baseVersion: 1, baseId: id(70), ops: [{ op: 'setTreatment', shotKey: 'SH003', treatment: 'GENERATED_STILL' }] } };
    expect(StoryboardContent.parse(edited).provenance.ops).toHaveLength(1);
    expect(StoryboardContent.safeParse({ ...edited, provenance: { ...edited.provenance, ops: [{ op: 'rewriteEverything' }] } }).success).toBe(false);
  });

  it('is engine 1, estimated from audio, never from words', () => {
    expect(StoryboardContent.safeParse({ ...content(), engineVersion: 2 }).success).toBe(false);
    expect(StoryboardContent.safeParse({ ...content(), costs: { ...content().costs, basis: 'VENDOR_REPORTED' } }).success).toBe(false);
  });

  it('freezes a pricing snapshot with a source, a check date and a confidence for every card', () => {
    const pricing = {
      catalogVersion: '2026-10-07.1',
      cards: [{ provider: 'acme-video', model: 'acme-video-2', label: 'Acme Video 2', methods: ['GENERATIVE_VIDEO'], rates: [{ model: 'acme-video-2', unit: 'VIDEO_SECONDS', usdPerUnit: 0.1125, source: 'acme.example/pricing (checked 2026-10-07)' }], source: 'acme.example/pricing', checkedAt: '2026-10-07', confidence: 'ASSUMPTION' }],
    };
    expect(VisualPricingSnapshot.parse(pricing)).toEqual(pricing);
    expect(VisualPricingSnapshot.safeParse({ ...pricing, cards: [{ ...pricing.cards[0], confidence: 'GUESS' }] }).success).toBe(false);
    for (const card of [{ source: '' }, { checkedAt: '' }, { checkedAt: '07/10/2026' }, { rates: [{ ...pricing.cards[0]!.rates[0], source: '' }] }]) {
      expect(VisualPricingSnapshot.safeParse({ ...pricing, cards: [{ ...pricing.cards[0], ...card }] }).success, JSON.stringify(card)).toBe(false);
    }
  });

  it('never shows an unpriced rollup as $0: nothing priced has no total, and unpriced shots make the basis UNPRICED or MIXED', () => {
    const bucket = (over: Record<string, unknown>) => ({ key: 'ARCHIVAL_IMAGE', shots: 3, totalUsd: null, unpricedShots: 3, basis: 'UNPRICED', ...over });
    expect(CostBucket.safeParse(bucket({})).success).toBe(true);
    expect(CostBucket.safeParse(bucket({ totalUsd: 0 })).success).toBe(false);
    expect(CostBucket.safeParse(bucket({ unpricedShots: 0 })).success).toBe(false);
    expect(CostBucket.safeParse(bucket({ totalUsd: 4.5, unpricedShots: 1, basis: 'ESTIMATED' })).success).toBe(false);
    expect(CostBucket.safeParse(bucket({ totalUsd: 4.5, unpricedShots: 1, basis: 'MIXED' })).success).toBe(true);
    expect(CostBucket.safeParse(bucket({ totalUsd: null, unpricedShots: 1, basis: 'MIXED' })).success).toBe(false);
    expect(CostBucket.safeParse(bucket({ totalUsd: 0, unpricedShots: 0, basis: 'MOCK' })).success).toBe(true);

    const c = content();
    const allUnpriced = { ...c.costs, totalUsd: null, basis: 'UNPRICED', unpricedShots: 18, byTreatment: [bucket({ key: 'ARCHIVAL_IMAGE', shots: 18, unpricedShots: 18 })] };
    expect(CostRollup.safeParse(allUnpriced).success).toBe(true);
    expect(CostRollup.safeParse({ ...allUnpriced, totalUsd: 0 }).success).toBe(false);
    expect(CostRollup.safeParse({ ...c.costs, unpricedShots: 3, basis: 'ESTIMATED' }).success).toBe(false);
    // A bucket inside the rollup is held to the same rule.
    expect(CostRollup.safeParse({ ...c.costs, byTreatment: [bucket({ totalUsd: 0 })] }).success).toBe(false);

    const option = c.approaches.options[0]!;
    expect(ApproachSummary.safeParse({ ...option, estimatedCostUsd: null, costBasis: 'UNPRICED' }).success).toBe(true);
    expect(ApproachSummary.safeParse({ ...option, estimatedCostUsd: 0, costBasis: 'UNPRICED' }).success).toBe(false);

    const alternative = c.alternatives[0]!;
    expect(CostAlternative.safeParse({ ...alternative, afterUsd: null, savingUsd: null, basis: 'MIXED' }).success).toBe(true);
    expect(CostAlternative.safeParse({ ...alternative, afterUsd: null, savingUsd: 34, basis: 'MIXED' }).success).toBe(false);
    expect(CostAlternative.safeParse({ ...alternative, savingUsd: null }).success).toBe(false);
  });
});

describe('NarrationSpine', () => {
  it('round-trips the pinned assembly as the voice module reads it', () => {
    expect(NarrationSpine.parse(spine())).toEqual(spine());
    const unaligned = spine();
    unaligned.takes[0]!.alignment = null as never;
    expect(NarrationSpine.parse(unaligned).takes[0]!.alignment).toBeNull();
  });

  it('is strict: a bad fingerprint, no entries or a malformed span fail loudly', () => {
    expect(NarrationSpine.safeParse({ ...spine(), assembly: { ...spine().assembly, fingerprint: 'abc' } }).success).toBe(false);
    expect(NarrationSpine.safeParse({ ...spine(), entries: [] }).success).toBe(false);
    expect(NarrationSpine.safeParse({ ...spine(), chunks: [{ ...spine().chunks[0], spans: [{ blockKey: '1.1', start: 0, end: 4 }] }] }).success).toBe(false);
    expect(NarrationSpine.safeParse({ ...spine(), run: { ...spine().run, kind: 'DEMO' } }).success).toBe(false);
  });

  it('fingerprints the clips and their places only: equal for identical entries, different for any move', () => {
    const entries = spine().entries;
    const same = narrationFingerprintText(entries.map((e) => ({ ...e, generation: 9, audioAssetId: id(99) })));
    expect(same).toBe(narrationFingerprintText(entries));
    expect(narrationFingerprintText(entries.map((e) => ({ ...e, gapAfterMs: 1 })))).not.toBe(same);
    expect(narrationFingerprintText(entries.map((e) => ({ ...e, generationId: id(98) })))).not.toBe(same);
    expect(narrationFingerprintText(entries.map((e) => ({ ...e, endMs: e.endMs + 10 })))).not.toBe(same);
  });
});

describe('job input and edits', () => {
  const narration = { runId: id(43), assemblyId: id(44) };

  it('plans, switches approach or re-plans beats, each with what it needs and nothing else', () => {
    expect(StoryboardJobInput.parse({ mode: 'GENERATE', narration, selectionRevision: 0, requestedBy: 'editor' })).toMatchObject({ mode: 'GENERATE' });
    expect(StoryboardJobInput.parse({ mode: 'APPROACH', narration, approach: 'B', base: { storyboardId: id(70), version: 2 }, selectionRevision: 3, requestedBy: 'editor' })).toMatchObject({ approach: 'B' });
    expect(StoryboardJobInput.parse({ mode: 'BEATS', narration, base: { storyboardId: id(70), version: 2 }, beatKeys: ['VB03'], instructions: 'Show the ledger', selectionRevision: 3, requestedBy: 'editor' })).toMatchObject({ beatKeys: ['VB03'] });
    const refused = [
      { mode: 'GENERATE', narration, base: { storyboardId: id(70), version: 2 }, selectionRevision: 0, requestedBy: 'editor' },
      { mode: 'APPROACH', narration, base: { storyboardId: id(70), version: 2 }, selectionRevision: 0, requestedBy: 'editor' },
      { mode: 'BEATS', narration, base: { storyboardId: id(70), version: 2 }, selectionRevision: 0, requestedBy: 'editor' },
      { mode: 'BEATS', narration, beatKeys: ['VB03'], selectionRevision: 0, requestedBy: 'editor' },
      { mode: 'GENERATE', narration, beatKeys: ['VB03'], selectionRevision: 0, requestedBy: 'editor' },
      { mode: 'GENERATE', narration, instructions: 'more drama', selectionRevision: 0, requestedBy: 'editor' },
      { mode: 'GENERATE', narration: { runId: 'run-3', assemblyId: id(44) }, selectionRevision: 0, requestedBy: 'editor' },
      { mode: 'GENERATE', narration, selectionRevision: 0, requestedBy: 'editor', budgetUsd: 50 },
      { mode: 'GENERATE', narration, selectionRevision: -1, requestedBy: 'editor' },
    ];
    for (const input of refused) expect(StoryboardJobInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it('takes every edit of brief §22 as a structured operation', () => {
    const ops = [
      { op: 'updateShot', shotKey: 'SH003', patch: { description: 'A ledger page, close', treatment: 'DOCUMENT_ANIMATION', method: 'DOCUMENT_MOTION', claims: [{ claimKey: 'C014', role: 'SHOWS_SOURCE' }] } },
      { op: 'updateShot', shotKey: 'SH003', patch: { infoClass: 'UNCERTAIN', subjects: [{ subjectKey: 'CS02', detail: { role: 'BACKGROUND', action: '', interactions: [], likeness: 'SILHOUETTE', speaks: null } }] } },
      { op: 'setTreatment', shotKey: 'SH003', treatment: 'GENERATED_STILL', method: 'STILL_MOTION' },
      { op: 'moveCut', leftShotKey: 'SH003', rightShotKey: 'SH004', to: '1.4:7', offsetMs: -400 },
      { op: 'splitShot', shotKey: 'SH003', at: '1.3:9' },
      { op: 'mergeShots', shotKeys: ['SH003', 'SH004'] },
      { op: 'reorderShots', beatKey: 'VB02', order: ['SH004', 'SH003'] },
      { op: 'updateBeat', beatKey: 'VB02', patch: { concept: 'The ledger as the turning point', importance: 'HERO' } },
      { op: 'setRecommendation', shotKey: 'SH003', provider: 'acme-video', model: 'acme-video-2' },
      { op: 'clearRecommendation', shotKey: 'SH003' },
      { op: 'applyAlternative', alternativeId: 'alt-1' },
      { op: 'updateContinuity', subjectKey: 'CS01', patch: { designDetails: [{ detail: 'Gabled warehouses', basis: 'PERIOD_GENERIC', claimKeys: [] }] } },
      { op: 'setProfile', selectionRevision: 4 },
    ];
    for (const op of ops) expect(StoryboardEditOp.parse(op), op.op).toEqual(op);
    expect(StoryboardEditInput.parse({ expectedVersion: 2, ops, note: 'Fix the ledger beat' }).ops).toHaveLength(ops.length);
  });

  it('refuses an edit it cannot apply exactly', () => {
    const refused = [
      { op: 'updateShot', shotKey: 'SH003', patch: {} },
      { op: 'updateShot', shotKey: 'SH003', patch: { depiction: 'RECORD' } },
      { op: 'updateShot', shotKey: 'SH003', patch: { startMs: 1200 } },
      { op: 'updateShot', shotKey: 'SH003', patch: { prompt: 'cinematic, 8k' } },
      { op: 'moveCut', leftShotKey: 'SH003', rightShotKey: 'SH004', to: '1.4:7', offsetMs: 2001 },
      { op: 'moveCut', leftShotKey: 'SH003', rightShotKey: 'SH004', to: 4200 },
      { op: 'mergeShots', shotKeys: ['SH003', 'SH004', 'SH005'] },
      { op: 'reorderShots', beatKey: 'VB02', order: ['SH004'] },
      { op: 'updateBeat', beatKey: 'VB02', patch: {} },
      { op: 'updateContinuity', subjectKey: 'CS01', patch: { castId: 'R9' } },
      { op: 'regenerateEverything' },
    ];
    for (const op of refused) expect(StoryboardEditOp.safeParse(op).success, JSON.stringify(op)).toBe(false);
    expect(StoryboardEditInput.safeParse({ expectedVersion: 2, ops: [] }).success).toBe(false);
  });
});

describe('storyboard request inputs', () => {
  it('needs the request to confirm a paid planning call', () => {
    const input = { narration: { runId: id(43) }, selectionRevision: 0, confirm: true };
    expect(GenerateStoryboardInput.parse(input)).toEqual(input);
    const unconfirmed = GenerateStoryboardInput.safeParse({ ...input, confirm: false });
    expect(unconfirmed.success).toBe(false);
    expect(unconfirmed.error?.issues[0]?.message).toMatch(/confirm/);
    expect(GenerateStoryboardInput.safeParse({ narration: { runId: id(43) }, selectionRevision: 0 }).success).toBe(false);
    expect(RegenerateBeatsInput.safeParse({ beatKeys: ['VB02'], expectedVersion: 2 }).success).toBe(false);
  });

  it('names the artifact version a gate decision was made on, and keeps decisions to their own kinds', () => {
    expect(ApprovalInput.parse({ gate: 'STORYBOARD', decision: 'APPROVED', artifactId: id(70) }).artifactId).toBe(id(70));
    expect(ApprovalInput.parse({ gate: 'SCRIPT', decision: 'APPROVED' }).artifactId).toBeUndefined();
    expect(ApprovalInput.safeParse({ gate: 'STORYBOARD', decision: 'APPROVED', artifactId: 'v3' }).success).toBe(false);
    expect(StoryboardDecisionInput.safeParse({ decision: 'CLEARED', expectedVersion: 1 }).success).toBe(false);
    expect(StoryboardDecisionInput.safeParse({ decision: 'CHANGES_REQUESTED', expectedVersion: 1 }).success).toBe(true);
    expect(ShotDecisionInput.safeParse({ decision: 'CHANGES_REQUESTED' }).success).toBe(false);
    expect(ShotDecisionInput.safeParse({ decision: 'CLEARED' }).success).toBe(true);
  });

  it("takes a project's visual selection with strict overrides and its revision", () => {
    expect(VisualSelectionInput.parse({ familyId: null, revision: 0 })).toEqual({ familyId: null, overrides: {}, revision: 0 });
    expect(VisualSelectionInput.safeParse({ familyId: null, versionId: id(20), revision: 1 }).success).toBe(false);
    expect(VisualSelectionInput.safeParse({ familyId: id(47), overrides: { density: 'SPARSE', vendor: 'acme' }, revision: 1 }).success).toBe(false);
  });
});

describe('visual style profiles', () => {
  it('seeds the five presets of brief §21, provider-neutral, Cinematic History the default', () => {
    expect(VISUAL_PROFILE_PRESETS.map((p) => p.name)).toEqual(['Cinematic History', 'Corporate Investigative', 'Dark True Crime', 'Clean Business Explainer', 'Retro Documentary']);
    expect(new Set(VISUAL_PROFILE_PRESETS.map((p) => p.key)).size).toBe(5);
    for (const p of VISUAL_PROFILE_PRESETS) {
      expect(VisualStyleProfileConfig.parse(p.config), p.name).toEqual(p.config);
      expect(p.config.providerPreferences, p.name).toEqual({});
      expect(p.config.generation.rerolls, p.name).toEqual({});
    }
    expect(DEFAULT_VISUAL_PRESET).toBe('cinematic-history');
    expect(DEFAULT_VISUAL_PROFILE_CONFIG).toBe(VISUAL_PROFILE_PRESETS[0]!.config);
    expect(Object.isFrozen(VISUAL_PROFILE_PRESETS[0]!.config.generation)).toBe(true);
  });

  it('takes any setting as a project override, nested ones key by key, and refuses unknown keys', () => {
    const overrides = { density: 'SPARSE', generation: { maxGeneratedVideoShare: 0.2 }, colour: { palette: ['ochre'] }, providerPreferences: { GENERATIVE_VIDEO: [{ provider: 'acme-video', model: 'acme-video-2' }] }, costCeilingUsd: { total: 40 } };
    expect(VisualConfigOverrides.parse(overrides)).toEqual(overrides);
    expect(VisualConfigOverrides.safeParse({ density: 'BUSY' }).success).toBe(false);
    expect(VisualConfigOverrides.safeParse({ generation: { maxShots: 3 } }).success).toBe(false);
    expect(VisualConfigOverrides.safeParse({ generation: { maxGeneratedVideoShare: 1.5 } }).success).toBe(false);
    expect(VisualConfigOverrides.safeParse({ providerPreferences: { TELEPORT: [] } }).success).toBe(false);
    expect(VisualConfigOverrides.safeParse({ provider: 'acme-video' }).success).toBe(false);
  });

  it('records how a version was made', () => {
    for (const o of [{ kind: 'PRESET', preset: 'retro-documentary' }, { kind: 'DEFAULTS' }, { kind: 'LIBRARY' }, { kind: 'EDIT', basedOnVersion: 2 }, { kind: 'DUPLICATE', fromFamily: 'Cinematic History', fromVersion: 1 }]) {
      expect(VisualProfileOrigin.parse(o)).toEqual(o);
    }
    expect(VisualProfileOrigin.safeParse({ kind: 'STORYBOARD' }).success).toBe(false);
  });
});

describe('provider-neutral storyboard data', () => {
  it('gives every treatment a label, a definition and at least one production method, and uses every method', () => {
    for (const t of VISUAL_TREATMENTS) {
      expect(VISUAL_TREATMENT_LABELS[t], t).toBeTruthy();
      expect(VISUAL_TREATMENT_HELP[t], t).toBeTruthy();
      expect(TREATMENT_METHODS[t].length, t).toBeGreaterThan(0);
    }
    expect(new Set(Object.values(TREATMENT_METHODS).flat())).toEqual(new Set(PRODUCTION_METHODS));
    expect(GENERATED_VIDEO_METHODS.every((m) => GENERATIVE_METHODS.includes(m))).toBe(true);
    expect(GENERATIVE_METHODS.every((m) => METHOD_SOURCING[m] === 'GENERATE')).toBe(true);
    expect(SOURCING_METHODS.every((m) => METHOD_SOURCING[m] === 'SOURCE')).toBe(true);
  });

  it('never generates a record: record treatments are only ever sourced', () => {
    for (const t of RECORD_TREATMENTS) {
      expect(TREATMENT_METHODS[t].every((m) => SOURCING_METHODS.includes(m)), t).toBe(true);
      expect(TREATMENT_CLASS_RULES[t].FICTION.allowed, t).toBe(false);
      expect(TREATMENT_CLASS_RULES[t].DOCUMENTED, t).toEqual({ allowed: true, condition: 'SOURCED' });
    }
    // Brief §8: data and maps go to deterministic renderers, never to a generative model.
    for (const t of ['DATA_VISUALIZATION', 'TIMELINE', 'DIAGRAM', 'INFOGRAPHIC', 'MAP_ANIMATION'] as const) {
      expect(TREATMENT_METHODS[t].some((m) => GENERATIVE_METHODS.includes(m)), t).toBe(false);
    }
  });

  it('encodes the treatment × class matrix of §2.7', () => {
    const rule = (t: VisualTreatment, c: (typeof SCRIPT_BLOCK_CLASSES)[number]) => TREATMENT_CLASS_RULES[t][c];
    expect(rule('CINEMATIC_RECONSTRUCTION', 'DOCUMENTED')).toEqual({ allowed: true, condition: 'GROUNDED_SPECIFICS' });
    expect(rule('CINEMATIC_RECONSTRUCTION', 'RECONSTRUCTION')).toEqual({ allowed: true, condition: null });
    expect(rule('CINEMATIC_RECONSTRUCTION', 'UNCERTAIN')).toEqual({ allowed: true, condition: 'VISIBLE_DEVICE' });
    expect(rule('CINEMATIC_RECONSTRUCTION', 'FRAMING')).toEqual({ allowed: true, condition: 'NO_DEPICTS' });
    expect(rule('DOCUMENT_ANIMATION', 'FRAMING').allowed).toBe(false);
    expect(rule('MAP_ANIMATION', 'UNCERTAIN')).toEqual({ allowed: true, condition: 'UNCERTAINTY_MARKED' });
    expect(rule('DATA_VISUALIZATION', 'RECONSTRUCTION')).toEqual({ allowed: true, condition: 'HEDGED_DATA' });
    expect(rule('DATA_VISUALIZATION', 'UNCERTAIN')).toEqual({ allowed: true, condition: 'RANGES_CAPTIONED' });
    expect(rule('INFOGRAPHIC', 'FRAMING').allowed).toBe(false);
    expect(rule('TIMELINE', 'FRAMING')).toEqual({ allowed: true, condition: null });
    expect(rule('PORTRAIT', 'DOCUMENTED')).toEqual({ allowed: true, condition: 'DOCUMENTED_LIKENESS' });
    expect(rule('PORTRAIT', 'UNCERTAIN')).toEqual({ allowed: true, condition: 'NON_IDENTIFYING' });
    expect(rule('PORTRAIT', 'FRAMING').allowed).toBe(false);
    expect(rule('CHARACTER_VISUAL', 'DOCUMENTED')).toEqual({ allowed: true, condition: 'NON_IDENTIFYING' });
    expect(rule('ABSTRACT_METAPHOR', 'DOCUMENTED')).toEqual({ allowed: true, condition: 'NO_DEPICTS' });
    expect(rule('TEXT_ON_SCREEN', 'DOCUMENTED')).toEqual({ allowed: true, condition: 'VERIFIED_QUOTE' });
    expect(rule('TEXT_ON_SCREEN', 'UNCERTAIN')).toEqual({ allowed: true, condition: 'PRESENTATION_WORDING' });
    for (const c of SCRIPT_BLOCK_CLASSES) expect(rule('ENVIRONMENT', c)).toEqual({ allowed: true, condition: null });
    for (const t of VISUAL_TREATMENTS) for (const c of SCRIPT_BLOCK_CLASSES) if (!rule(t, c).allowed) expect(rule(t, c).condition, `${t} ${c}`).toBeNull();
    expect(treatmentsFor('FICTION')).not.toContain('ARCHIVAL_IMAGE');
    expect(treatmentsFor('FICTION')).toContain('CHARACTER_VISUAL');
    expect(treatmentsFor('FRAMING')).not.toContain('DATA_VISUALIZATION');
  });

  it("seeds a treatment from the script's visual intent (a fictional portrait is a character visual)", () => {
    for (const i of VISUAL_INTENTS) expect(i in INTENT_TREATMENT_SEED, i).toBe(true);
    expect(INTENT_TREATMENT_SEED.DOCUMENT).toBe('DOCUMENT_ANIMATION');
    expect(INTENT_TREATMENT_SEED.NONE).toBeNull();
    expect(seedTreatment('PORTRAIT', false)).toBe('PORTRAIT');
    expect(seedTreatment('PORTRAIT', true)).toBe('CHARACTER_VISUAL');
    expect(seedTreatment('MAP', true)).toBe('MAP_ANIMATION');
  });

  it('allows rerolls for generated pictures only (brief §16: 1.5 for generated video, 1.3 for a still)', () => {
    expect(DEFAULT_REROLLS.GENERATIVE_VIDEO).toBe(1.5);
    expect(DEFAULT_REROLLS.IMAGE_TO_VIDEO).toBe(1.5);
    expect(DEFAULT_REROLLS.GENERATIVE_IMAGE).toBe(1.3);
    for (const m of PRODUCTION_METHODS) if (!GENERATIVE_METHODS.includes(m)) expect(DEFAULT_REROLLS[m], m).toBe(0);
  });

  it('sets density targets that grow denser in order, and shot limits from §2.3', () => {
    const order = ['SPARSE', 'BALANCED', 'DENSE'] as const;
    for (const d of order) expect(DENSITY_TARGETS[d].averageShotSec.min).toBeLessThan(DENSITY_TARGETS[d].averageShotSec.max);
    expect(order.map((d) => DENSITY_TARGETS[d].maxCutsPerMinute)).toEqual([9, 14, 22]);
    expect(SHOT_LIMITS).toMatchObject({ minMs: 700, transitionMinMs: 200, maxMs: 60_000, staticWarnMs: 12_000, noChangeWarnMs: 20_000, rapidCutMs: 1_500, maxSameTreatmentRun: 4, uniformDurationCv: 0.1 });
  });

  it('derives the depiction from treatment, method and content, never from a proposal', () => {
    const f = (over: Partial<DepictionFacts>): DepictionFacts => ({ treatment: 'CINEMATIC_RECONSTRUCTION', method: 'GENERATIVE_VIDEO', fictionalSubject: false, subjects: false, objects: false, depicts: false, ...over });
    expect(depictionFor(f({ fictionalSubject: true, treatment: 'ENVIRONMENT' }))).toBe('FICTIONAL');
    expect(depictionFor(f({ treatment: 'ARCHIVAL_IMAGE', method: 'ARCHIVAL_SOURCING' }))).toBe('RECORD');
    expect(depictionFor(f({ treatment: 'DOCUMENT_ANIMATION', method: 'DOCUMENT_MOTION' }))).toBe('RECORD');
    expect(depictionFor(f({ treatment: 'ARCHIVAL_IMAGE', method: 'GENERATIVE_IMAGE' }))).toBe('RECONSTRUCTED');
    expect(depictionFor(f({ treatment: 'NEWS_FOOTAGE', method: 'MOTION_DESIGN' }))).toBe('RECONSTRUCTED');
    expect(depictionFor(f({ treatment: 'MAP_ANIMATION', method: 'MAP_RENDER', depicts: true }))).toBe('DATA');
    expect(depictionFor(f({ treatment: 'DATA_VISUALIZATION', method: 'GENERATIVE_IMAGE' }))).toBe('RECONSTRUCTED');
    // A generated picture that shows people or depicts a claim is a reconstruction whatever its treatment is called,
    // so a "metaphor" of a disputed act still needs its uncertainty device (UNCERTAIN_AS_FACT applies to RECONSTRUCTED).
    expect(depictionFor(f({ treatment: 'ABSTRACT_METAPHOR', method: 'GENERATIVE_VIDEO', depicts: true }))).toBe('RECONSTRUCTED');
    expect(depictionFor(f({ treatment: 'ABSTRACT_METAPHOR', method: 'GENERATIVE_VIDEO', subjects: true }))).toBe('RECONSTRUCTED');
    expect(depictionFor(f({ treatment: 'TEXT_ON_SCREEN', method: 'GENERATIVE_IMAGE', depicts: true }))).toBe('RECONSTRUCTED');
    expect(depictionFor(f({ treatment: 'ABSTRACT_METAPHOR', method: 'GENERATIVE_VIDEO', objects: true }))).toBe('ILLUSTRATIVE');
    expect(depictionFor(f({ treatment: 'ABSTRACT_METAPHOR', method: 'GENERATIVE_VIDEO' }))).toBe('ILLUSTRATIVE');
    expect(depictionFor(f({ treatment: 'ABSTRACT_METAPHOR', method: 'MOTION_DESIGN', depicts: true, subjects: true }))).toBe('ILLUSTRATIVE');
    expect(depictionFor(f({ treatment: 'TEXT_ON_SCREEN', method: 'EDIT_TIME' }))).toBe('ILLUSTRATIVE');
    expect(depictionFor(f({ subjects: true }))).toBe('RECONSTRUCTED');
    expect(depictionFor(f({ objects: true }))).toBe('RECONSTRUCTED');
    expect(depictionFor(f({ depicts: true, method: 'STILL_MOTION' }))).toBe('RECONSTRUCTED');
    expect(depictionFor(f({}))).toBe('ILLUSTRATIVE');
    expect(depictionFor(f({ treatment: 'ENVIRONMENT', method: 'GENERATIVE_IMAGE', objects: true }))).toBe('ILLUSTRATIVE');
    expect(depictionFor(f({ treatment: 'ENVIRONMENT', method: 'GENERATIVE_IMAGE', depicts: true }))).toBe('RECONSTRUCTED');
    expect(depictionFor(f({ treatment: 'PRODUCT_OBJECT', method: 'STOCK_SOURCING', subjects: true }))).toBe('ILLUSTRATIVE');
    expect(depictionFor(f({ treatment: 'PORTRAIT', method: 'ARCHIVAL_SOURCING', subjects: true }))).toBe('RECORD');
    expect(depictionFor(f({ treatment: 'PORTRAIT', method: 'GENERATIVE_IMAGE', subjects: true }))).toBe('RECONSTRUCTED');
    for (const t of VISUAL_TREATMENTS) expect(t in DEPICTION_FOR, t).toBe(true);
  });

  it('keeps every artifact status a storyboard status (the migration casts the column in place)', () => {
    for (const s of ARTIFACT_STATUSES) expect(STORYBOARD_STATUSES, s).toContain(s);
  });
});
