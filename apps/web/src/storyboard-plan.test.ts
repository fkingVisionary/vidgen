import {
  DEFAULT_VISUAL_PROFILE_CONFIG,
  VisualConfigOverrides,
  VisualStyleProfileConfig,
  type LabelTone,
  STORYBOARD_STATUS_TONES,
  VISUAL_TREATMENT_TONES,
  VISUAL_TREATMENTS,
  type ApproachSummaryView,
  type CutPointView,
  type ProjectDetailView,
  type RhythmStats,
  type ShotView,
  type StoryboardInputsView,
  type StoryboardDecisionView,
  type StoryboardSummaryView,
  type StoryboardVersionView,
  type VisualCostEstimate,
} from '@docengine/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDate } from './format.ts';
import {
  APPROACH_SHOTS_HINT,
  CLASS_BAR,
  VISUAL_FIELDS,
  VISUAL_ROW_PATHS,
  approachMixLine,
  approachesNote,
  approvalNeeds,
  assemblyText,
  changesLines,
  configChanges,
  evidenceRows,
  overridePaths,
  overridesFrom,
  phaseOpen,
  planDefaults,
  planRunText,
  planKind,
  perMinuteText,
  pricingRows,
  productionText,
  rateText,
  rhythmRows,
  sameSettings,
  shareOf,
  shotCostRows,
  usdOf,
  valueAt,
  withValue,
  wordsOf,
  TONE_BAR,
  TONE_PILL,
  ZOOM_LEVELS,
  blockRange,
  bucketLabel,
  bucketRows,
  clock,
  cutPointsBetween,
  decidedText,
  decisionText,
  defaultZoom,
  describeVisualOverrides,
  designDetailsFrom,
  detailRows,
  estimateUsd,
  factualShot,
  findingCounts,
  generationHeld,
  hasStoryboardPage,
  inputsStrip,
  laneBox,
  laneWidth,
  lowerClasses,
  mixShares,
  moved,
  nextInBeat,
  nextShot,
  rangeText,
  relationText,
  rollupText,
  rulerTicks,
  shotCostText,
  shotForm,
  shotFormProblems,
  shotPatch,
  statusNoteText,
  storyboardNote,
  summaryLine,
  takesApproved,
  treatmentMix,
  versionLabel,
  visualConfigRows,
  visualOriginText,
  whyChain,
} from './storyboard-plan.ts';

/** A shot as the API returns it, with the fields a test does not set filled. */
function shot(over: Partial<ShotView> = {}): ShotView {
  const key = over.key ?? 'SH001';
  const base: ShotView = {
    id: `id-${key}`,
    key,
    beatKey: 'VB01',
    sortOrder: 0,
    sectionKey: 'SC01',
    startMs: 0,
    endMs: 4000,
    durationMs: 4000,
    relation: 'TIMED_TO_NARRATION',
    timing: {
      narration: { from: '1.1:0', to: '1.1:end' },
      narrationStartMs: 200,
      narrationEndMs: 3800,
      leadInMs: 0,
      tailOutMs: 0,
      bridge: null,
      visualFrom: null,
      visualTo: null,
      silenceAt: null,
      cutIn: 'SCOPE_EDGE',
      cutOut: 'SENTENCE_END',
      audio: [],
      unalignedTake: false,
    },
    narrationAnchor: '1.1:0–1.1:end',
    narration: { text: 'The quay was quiet', blocks: [] },
    unplanned: false,
    treatment: 'ENVIRONMENT',
    method: 'GENERATIVE_IMAGE',
    infoClass: 'RECONSTRUCTION',
    spec: {
      purpose: 'Sets the place.',
      description: 'An empty quay at dusk.',
      composition: 'Wide.',
      shotType: 'WIDE',
      camera: { angle: 'eye level', lens: null },
      movement: { motion: 'PUSH_IN', intensity: 'LOW', note: '' },
      environment: { subjectKey: 'CS01', description: 'A quay.' },
      objects: [],
      lighting: 'Dusk.',
      mood: 'Quiet.',
      transitionIn: 'CUT',
      transitionOut: 'CUT',
      continuity: { subjectKeys: [], notes: [] },
      mustShow: [],
      mustAvoid: [{ text: 'modern clothing', origin: 'SCRIPT' }],
      specifics: [],
      overlays: [{ kind: 'RECONSTRUCTION_LABEL', text: 'Reconstruction', reason: 'automatic', claimKeys: [], auto: true }],
      uncertaintyDevice: 'NONE',
      dataSpec: null,
      depiction: 'ILLUSTRATIVE',
      styleOverrides: {},
      notes: [],
    },
    subjects: [],
    claims: [],
    evidence: null,
    assetRequirement: null,
    cost: null,
    decision: null,
    review: 'PENDING',
    why: {
      shot: { key, purpose: 'Sets the place.', treatment: 'ENVIRONMENT', depiction: 'ILLUSTRATIVE', infoClass: 'RECONSTRUCTION' },
      beat: { key: 'VB01', title: 'The quay', purpose: 'Orients', concept: 'The place before the story' },
      narration: { text: 'The quay was quiet', startMs: 200, endMs: 3800 },
      blocks: [{ id: 'b1', key: '1.1', infoClass: 'RECONSTRUCTION', text: 'The quay was quiet.', beatIds: ['1.1'] }],
      architecture: {
        beats: [{ id: '1.1', function: 'COLD_OPEN', basis: 'RECONSTRUCTION', description: 'Night on the quay.' }],
        sequence: { number: 1, title: 'The harbour', setting: { location: { value: 'the harbour', basis: 'DOCUMENTED' }, date: { value: '', basis: 'RECONSTRUCTION' }, timeOfDay: { value: 'dusk', basis: 'RECONSTRUCTION' } } },
      },
      claims: [],
      sources: [],
    },
    findings: [],
    contentHash: 'hash',
  };
  return { ...base, ...over };
}

const estimate = (over: Partial<VisualCostEstimate> = {}): VisualCostEstimate => ({
  method: 'GENERATIVE_VIDEO',
  provider: 'acme-video',
  model: 'acme-v1',
  source: 'ROUTER',
  lines: [{ what: '8 s', usage: [{ unit: 'VIDEO_SECONDS', quantity: 8 }], rate: { unit: 'VIDEO_SECONDS', usdPerUnit: 0.1125, source: 'acme list (checked 2026-10-07)', checkedAt: '2026-10-07', confidence: 'ASSUMPTION' } }],
  perGenerationUsd: 0.9,
  rerollAllowance: 1.5,
  generations: 2.5,
  totalUsd: 2.25,
  basis: 'ESTIMATED',
  durationSource: 'AUDIO',
  billedClipSec: 8,
  note: '8 s × $0.1125/s × 2.5 generations',
  generationSec: 8,
  confidence: 'ASSUMPTION',
  candidates: [],
  ...over,
});

describe('tones', () => {
  it('give every semantic tone a pill and a lane colour, and every class a lane colour', () => {
    const tones: LabelTone[] = ['NEUTRAL', 'INFO', 'PENDING', 'SUCCESS', 'WARNING', 'DANGER'];
    for (const t of tones) {
      expect(TONE_PILL[t]).toMatch(/^bg-\S+ text-\S+$/);
      expect(TONE_BAR[t]).toMatch(/^border-\S+ bg-\S+ text-\S+$/);
    }
    expect(new Set(Object.values(TONE_PILL)).size).toBe(tones.length);
    for (const t of VISUAL_TREATMENTS) expect(TONE_BAR[VISUAL_TREATMENT_TONES[t]]).toBeDefined();
    expect(TONE_PILL[STORYBOARD_STATUS_TONES.CHANGES_REQUESTED]).toBe('bg-amber-100 text-amber-900');
    expect(TONE_PILL[STORYBOARD_STATUS_TONES.APPROVED]).toBe('bg-emerald-100 text-emerald-800');
    expect(Object.keys(CLASS_BAR).sort()).toEqual(['DOCUMENTED', 'FICTION', 'FRAMING', 'RECONSTRUCTION', 'UNCERTAIN']);
  });
});

describe('the narration clock and the timeline lanes', () => {
  it('read times as the voice page does, and block ranges as a span', () => {
    expect(clock(0)).toBe('0:00.0');
    expect(clock(64_249)).toBe('1:04.2');
    expect(clock(109_800)).toBe('1:49.8');
    expect(rangeText(3_167, 8_511)).toBe('0:03.2–0:08.5');
    expect(blockRange(['1.1', '1.2', '1.10'])).toBe('1.1–1.10');
    expect(blockRange(['2.4'])).toBe('2.4');
    expect(blockRange([])).toBe('none');
  });

  it('scale the lanes in px per second, the default zoom keeping a short opening wide and a long film narrow', () => {
    expect(defaultZoom(109_800)).toBe(16);
    expect(defaultZoom(30_000)).toBe(64);
    expect(defaultZoom(30 * 60_000)).toBe(ZOOM_LEVELS[0]);
    expect(laneWidth(109_800, 16)).toBe(1757);
    expect(laneBox(3_167, 8_511, 16)).toEqual({ left: 50.7, width: 85.5 });
    // A very short span stays visible; a reversed one never has a negative width.
    expect(laneBox(1_000, 1_010, 4).width).toBe(1);
    expect(laneBox(1_000, 900, 16).width).toBe(1);
  });

  it('put ruler ticks at a step that keeps their labels apart', () => {
    expect(rulerTicks(20_000, 16).map((t) => t.label)).toEqual(['0:00', '0:05', '0:10', '0:15', '0:20']);
    expect(rulerTicks(125_000, 4).map((t) => t.label)).toEqual(['0:00', '0:15', '0:30', '0:45', '1:00', '1:15', '1:30', '1:45', '2:00']);
    expect(rulerTicks(3_000, 64).map((t) => t.atMs)).toEqual([0, 1000, 2000, 3000]);
  });

  it('measure the treatment mix by runtime, a placeholder shot included as "no treatment"', () => {
    const mix = treatmentMix([
      shot({ treatment: 'ENVIRONMENT', durationMs: 3000 }),
      shot({ treatment: 'TEXT_ON_SCREEN', durationMs: 1000 }),
      shot({ treatment: 'ENVIRONMENT', durationMs: 2000 }),
      shot({ treatment: null, durationMs: 4000 }),
    ]);
    expect(mix).toEqual([
      { treatment: 'ENVIRONMENT', ms: 5000, share: 0.5 },
      { treatment: null, ms: 4000, share: 0.4 },
      { treatment: 'TEXT_ON_SCREEN', ms: 1000, share: 0.1 },
    ]);
    expect(treatmentMix([])).toEqual([]);
    expect(mixShares({ MAP_ANIMATION: 1000, CINEMATIC_RECONSTRUCTION: 3000 })).toEqual([
      { treatment: 'CINEMATIC_RECONSTRUCTION', share: 0.75 },
      { treatment: 'MAP_ANIMATION', share: 0.25 },
    ]);
  });

  it("labels an approach card's mix by runtime and says how much the cut hides", () => {
    expect(approachMixLine({ CINEMATIC_RECONSTRUCTION: 32_000, ENVIRONMENT: 24_000, DOCUMENT_ANIMATION: 16_000, TIMELINE: 8_000, ARCHIVAL_IMAGE: 7_000, CHARACTER_VISUAL: 7_000, MOTION_GRAPHIC: 6_000 })).toBe(
      'By runtime: Cinematic reconstruction 32% · Environment 24% · Document animation 16% · Timeline 8% · +3 more (20%)',
    );
    expect(approachMixLine({ CINEMATIC_RECONSTRUCTION: 90_000, CHARACTER_VISUAL: 10_000 })).toBe('By runtime: Cinematic reconstruction 90% · Character visual 10%');
    expect(approachMixLine({})).toBe('');
    expect(approachMixLine({ ENVIRONMENT: 3_000, TIMELINE: 1_000 }, 1, 'By runtime (the planned shots)')).toBe('By runtime (the planned shots): Environment 75% · +1 more (25%)');
  });

  it('say how the approach cards were estimated, as the version saved them', () => {
    const cards = (other: ApproachSummaryView['estimate']) => ({ approach: 'C' as const, approaches: (['A', 'B', 'C'] as const).map((approach) => ({ approach, chosen: approach === 'C', estimate: approach === 'C' ? ('PLANNED' as const) : other }) as ApproachSummaryView) });
    expect(approachesNote(cards('KEPT_AS_PLANNED'))).toBe(
      "The C card is this version's own forecast. For the others, beats they keep are counted from this version's shots, and beats they change are estimated at the profile's density. Switching re-plans only those beats (a paid planning job); this version is kept.",
    );
    // A version saved before (production v1): its A and B cards estimated every beat at the density.
    expect(approachesNote(cards('DENSITY'))).toBe(
      "The C card is this version's own forecast. The others were estimated when this version was saved, every beat at the profile's density. Switching re-plans only the beats whose treatment changes (a paid planning job); this version is kept.",
    );
    expect(cards('DENSITY').approaches.map((a) => APPROACH_SHOTS_HINT[a.estimate])).toEqual(["every beat at the profile's shot length", "every beat at the profile's shot length", "this version's shots"]);
    expect(APPROACH_SHOTS_HINT.KEPT_AS_PLANNED).toBe("kept beats as planned, changed beats at the profile's shot length");
  });
});

describe('relations', () => {
  it('say how the picture sits against its words, with the numbers code computed', () => {
    const t = shot().timing;
    expect(relationText(shot())).toBe('Timed to the narration');
    expect(relationText(shot({ relation: 'LEAD_IN', timing: { ...t, leadInMs: 800 } }))).toBe('Leads in by 0.8 s');
    expect(relationText(shot({ relation: 'LEAD_IN', timing: { ...t, leadInMs: 800, tailOutMs: 1200 } }))).toBe('Leads in by 0.8 s, tails out by 1.2 s');
    expect(relationText(shot({ relation: 'TAIL_OUT', timing: { ...t, tailOutMs: 1200 } }))).toBe('Tails out by 1.2 s');
    expect(relationText(shot({ relation: 'BRIDGE', timing: { ...t, bridge: { kind: 'SECTION', fromBlockId: 'a', toBlockId: 'b' }, tailOutMs: 500 } }))).toBe('Bridges two sections, tails out by 0.5 s');
    expect(relationText(shot({ relation: 'BRIDGE', timing: { ...t, narration: null, narrationStartMs: null, narrationEndMs: null, silenceAt: '1.2:end', bridge: { kind: 'SILENCE', fromBlockId: null, toBlockId: null } } }))).toBe('Fills a silence');
  });
});

describe('forecasts', () => {
  it('read as estimates, a fraction of a cent as such, and no price never as $0', () => {
    expect(estimateUsd(2.25)).toBe('~$2.25');
    expect(estimateUsd(0)).toBe('~$0.00');
    expect(estimateUsd(0.0057)).toBe('~$0.01');
    expect(estimateUsd(0.004)).toBe('<$0.01');
    expect(estimateUsd(null)).toBe('unpriced');
  });

  it('roll up with the unpriced shots always said, and nothing priced read as unpriced', () => {
    expect(rollupText({ totalUsd: 12.63933, basis: 'ESTIMATED', unpricedShots: 0 })).toBe('~$12.64 estimate');
    expect(rollupText({ totalUsd: 4.2, basis: 'MIXED', unpricedShots: 3 })).toBe('~$4.20 estimate · 3 shots unpriced (not in the total)');
    expect(rollupText({ totalUsd: 4.2, basis: 'MIXED', unpricedShots: 1 })).toBe('~$4.20 estimate · 1 shot unpriced (not in the total)');
    expect(rollupText({ totalUsd: null, basis: 'UNPRICED', unpricedShots: 5 })).toBe('Unpriced: no verified price for 5 shots');
    expect(rollupText({ totalUsd: 0, basis: 'MOCK', unpricedShots: 0 })).toBe('~$0.00 estimate (mock prices)');
    expect(rollupText({ totalUsd: null, basis: 'UNPRICED', unpricedShots: 5 })).not.toMatch(/\$0/);
  });

  it('give a shot its forecast in a line: generations and how sure, or why unpriced', () => {
    expect(shotCostText(estimate())).toBe('~$2.25 estimate (2.5 generations, assumption)');
    expect(shotCostText(estimate({ confidence: 'LIST_PRICE', totalUsd: 1.344, generations: 1 }))).toBe('~$1.34 estimate (1 generation, list price)');
    expect(shotCostText(estimate({ basis: 'UNPRICED', totalUsd: null, perGenerationUsd: null, confidence: null, note: 'No price configured for archival-item' }))).toBe('Unpriced: No price configured for archival-item');
    expect(shotCostText(estimate({ lines: [], totalUsd: 0, note: 'Reuses SH003' }))).toBe('~$0.00 estimate');
    expect(shotCostText(null)).toBe('No forecast (a placeholder shot)');
  });

  it('list cost buckets with their keys labelled, priced ones first', () => {
    const rows = bucketRows(
      [
        { key: 'TEXT_ON_SCREEN', shots: 1, totalUsd: 0, unpricedShots: 0, basis: 'ESTIMATED' },
        { key: 'ARCHIVAL_IMAGE', shots: 2, totalUsd: null, unpricedShots: 2, basis: 'UNPRICED' },
        { key: 'CINEMATIC_RECONSTRUCTION', shots: 4, totalUsd: 8.4, unpricedShots: 0, basis: 'ESTIMATED' },
      ],
      bucketLabel,
    );
    expect(rows.map((r) => [r.label, r.total, r.unpriced])).toEqual([
      ['Cinematic reconstruction', '~$8.40', 0],
      ['Text on screen', '~$0.00', 0],
      ['Archival image', 'unpriced', 2],
    ]);
    expect(bucketLabel('GENERATIVE_VIDEO')).toBe('Generated video');
    expect(bucketLabel('none')).toBe('None needed');
    expect(bucketLabel('acme-video acme-v1')).toBe('acme-video acme-v1');
  });
});

const summary = (over: Partial<StoryboardSummaryView> = {}): StoryboardSummaryView => ({
  id: 'sb',
  version: 3,
  status: 'IN_REVIEW',
  scope: 'PARTIAL',
  origin: 'EDIT',
  baseVersion: 2,
  approach: 'C',
  runtimeMs: 109_800,
  beatCount: 14,
  shotCount: 16,
  estimatedCostUsd: 12.6,
  costBasis: 'ESTIMATED',
  unpricedShotCount: 0,
  qaPassed: true,
  blocking: 0,
  warnings: 3,
  narration: { runId: 'r', runNumber: 3, runKind: 'AUDITION', assemblyId: 'a', assemblyVersion: 1, approval: 'UNREVIEWED' },
  stale: false,
  decidedBy: null,
  decidedAt: null,
  createdBy: 'editor',
  createdAt: '2026-10-07T00:00:00.000Z',
  ...over,
});

describe('versions, inputs and the project page', () => {
  it('label a version for the picker with its status, origin and base', () => {
    expect(versionLabel(summary())).toBe('v3 — In review — Edited (from v2) · preview');
    expect(versionLabel(summary({ version: 1, origin: 'GENERATED', baseVersion: null, scope: 'FULL', status: 'CHANGES_REQUESTED', stale: true }))).toBe('v1 — Changes requested — Planned from the narration · stale');
    expect(summaryLine(summary())).toBe('v3 · In review · preview · 1:49.8 · 14 beats, 16 shots');
  });

  it('read the inputs strip from what the version froze, the takes approved now', () => {
    const takes = Array.from({ length: 11 }, (_, i) => ({ generationId: `g${i}`, chunkIndex: i, status: i < 4 ? ('APPROVED' as const) : ('IN_REVIEW' as const), startMs: i * 10_000, endMs: i * 10_000 + 9_000, audioUrl: null }));
    const v = {
      inputs: {
        script: { id: 's', version: 5 },
        architecture: { id: 'a', version: 3, dossierId: 'd' },
        narration: { runId: 'r', runNumber: 3, runKind: 'AUDITION', assemblyId: 'x', assemblyVersion: 1, fingerprint: 'f'.repeat(64), languageVersionId: 'l', language: 'en', totalDurationMs: 109_800, complete: false, voiceProfileId: 'vp', takes: [], approval: 'UNREVIEWED' },
        profile: { familyName: 'Cinematic History', version: 1 },
      },
      scopeInfo: { kind: 'PARTIAL', blockKeys: ['1.1', '1.2', '1.10'], sectionKeys: ['SC01'], startMs: 0, endMs: 109_800, outOfScopeBlocks: 40 },
      narrationLane: { totalDurationMs: 109_800, blocks: [], silences: [], takes },
    } as unknown as StoryboardVersionView;
    expect(inputsStrip(v)).toEqual(['Script v5', 'Architecture v3', 'Voice run 3 (audition, blocks 1.1–1.10)', 'assembly v1', 'takes 4/11 approved, provisional timing', 'Visual profile Cinematic History v1', 'engine v1']);
    expect(takesApproved({ takes: takes.map((t) => ({ ...t, status: 'APPROVED' })) })).toEqual({ approved: 11, total: 11 });
    expect(inputsStrip({ ...v, narrationLane: { ...v.narrationLane, takes: takes.map((t) => ({ ...t, status: 'APPROVED' as const })) } })[4]).toBe('takes 11/11 approved');
  });

  it('show the Storyboard pill once narration is under review, with what needs doing', () => {
    const p = (status: ProjectDetailView['status'], storyboard: StoryboardSummaryView | null = null, failedFromStatus: ProjectDetailView['failedFromStatus'] = null) => ({ status, storyboard: storyboard && { ...storyboard, approved: null }, failedFromStatus });
    expect(hasStoryboardPage(p('SCRIPT_APPROVED'))).toBe(false);
    expect(hasStoryboardPage(p('VOICE_REVIEW'))).toBe(true);
    expect(hasStoryboardPage(p('FAILED', null, 'VISUAL_PLANNING'))).toBe(true);
    expect(hasStoryboardPage(p('SCRIPT_APPROVED', summary()))).toBe(true);
    expect(storyboardNote(p('VOICE_REVIEW'))).toBe('ready to plan');
    expect(storyboardNote(p('VOICE_REVIEW', summary()))).toBe('preview v3');
    expect(storyboardNote(p('VOICE_REVIEW', summary({ stale: true })))).toBe('stale');
    expect(storyboardNote(p('STORYBOARD_APPROVED', summary({ scope: 'FULL', version: 4 })))).toBe('v4');
    expect(storyboardNote(p('STORYBOARD_REVIEW', summary({ scope: 'FULL' })))).toBe('approval needed');
    expect(storyboardNote(p('VISUAL_PLANNING'))).toBe('planning…');
    expect(storyboardNote(p('SCRIPT_APPROVED'))).toBeNull();
  });

  it('say who decided a version, never that a person superseded it', () => {
    expect(decidedText({ status: 'IN_REVIEW', decidedBy: null })).toBeNull();
    expect(decidedText({ status: 'APPROVED', decidedBy: 'Ana' })).toBe('approved by Ana');
    expect(decidedText({ status: 'CHANGES_REQUESTED', decidedBy: 'Ana' })).toBe('changes requested by Ana');
    expect(decidedText({ status: 'REJECTED', decidedBy: 'Ana' })).toBe('rejected by Ana');
    expect(decidedText({ status: 'SUPERSEDED', decidedBy: 'Ana' })).toBe('decided by Ana');
  });

  it('read decisions with where they came from, and count findings', () => {
    expect(decisionText({ decision: 'APPROVED', decidedBy: 'Ana', carriedFromVersion: 1, note: 'steady', approvalId: null })).toBe('Approved by Ana — carried from v1: “steady”');
    expect(decisionText({ decision: 'CHANGES_REQUESTED', decidedBy: 'Ana', carriedFromVersion: null, note: null, approvalId: 'ap' })).toBe('Changes requested by Ana (the film’s storyboard approval)');
    expect(findingCounts([{ severity: 'BLOCKING' }, { severity: 'WARNING' }, { severity: 'WARNING' }])).toEqual({ blocking: 1, warnings: 2 });
  });
});

describe('why is this visual here', () => {
  it('runs from the shot through its beat, words, blocks and architecture to its claims and sources', () => {
    const s = shot({
      why: {
        ...shot().why,
        claims: [{ claimId: 'c', key: 'C12', statement: 'The quay was rebuilt in 1636.', role: 'DEPICTS', verdict: 'DISPUTED', savedVerdict: 'ESTABLISHED', confidence: 'MEDIUM', presentation: 'PRESENT_AS_DISPUTED', sourceIds: ['src'] }],
        sources: [{ id: 'src', title: 'Harbour records', url: null, quote: 'rebuilt in the year 1636' }],
      },
    });
    const chain = whyChain(s);
    expect(chain.map((x) => x.level)).toEqual(['Shot', 'Visual beat', 'Narration', 'Script block', 'Architecture beat', 'Sequence', 'Claim', 'Source']);
    expect(chain[0]).toEqual({ level: 'Shot', label: 'SH001 · Environment · Illustrative · Reconstruction', detail: 'Sets the place.' });
    expect(chain[2]).toEqual({ level: 'Narration', label: '0:00.2–0:03.8', detail: '“The quay was quiet”' });
    expect(chain[4]!.label).toBe('1.1 · Cold open · Reconstruction');
    expect(chain[5]).toEqual({ level: 'Sequence', label: 'Sequence 1: The harbour', detail: 'place the harbour (documented); time of day dusk (reconstruction)' });
    expect(chain[6]).toEqual({ level: 'Claim', label: 'C12 · Disputed (was Established when saved) · Depicts', detail: 'The quay was rebuilt in 1636.' });
    expect(chain[7]).toEqual({ level: 'Source', label: 'Harbour records', detail: '“rebuilt in the year 1636”' });
  });

  it('says so when the picture asserts nothing, and when a shot covers only a silence', () => {
    const silent = shot({ why: { ...shot().why, narration: { text: '', startMs: null, endMs: null } } });
    const chain = whyChain(silent);
    expect(chain.find((x) => x.level === 'Claim')).toEqual({ level: 'Claim', label: 'No claim', detail: 'The picture asserts no fact of the evidence.' });
    expect(chain.find((x) => x.level === 'Narration')).toEqual({ level: 'Narration', label: 'A silence (no words)', detail: '' });
  });
});

describe('editing', () => {
  const points: CutPointView[] = [
    { id: '1.1:0', kind: 'SCOPE_EDGE', blockKey: null, atMs: 0, silence: { startMs: 0, endMs: 0 }, midSentence: false },
    { id: '1.1:4', kind: 'CLAUSE', blockKey: '1.1', atMs: 1500, silence: { startMs: 1450, endMs: 1550 }, midSentence: true },
    { id: '1.1:end', kind: 'BLOCK', blockKey: '1.1', atMs: 3900, silence: { startMs: 3800, endMs: 4000 }, midSentence: false },
    { id: '1.2:6', kind: 'SENTENCE', blockKey: '1.2', atMs: 6000, silence: { startMs: 5900, endMs: 6100 }, midSentence: false },
  ];

  it('offer only the cut points strictly between two times', () => {
    expect(cutPointsBetween(points, 200, 3800).map((p) => p.id)).toEqual(['1.1:4']);
    expect(cutPointsBetween(points, 200, 7000, ['1.1:end']).map((p) => p.id)).toEqual(['1.1:4', '1.2:6']);
  });

  it('find a shot’s neighbours on the clock and in its beat, and move it within its beat', () => {
    const shots = [shot({ key: 'SH003', beatKey: 'VB02', startMs: 8000 }), shot({ key: 'SH001', startMs: 0 }), shot({ key: 'SH002', startMs: 4000 })];
    expect(nextInBeat(shots, 'SH001')?.key).toBe('SH002');
    expect(nextInBeat(shots, 'SH002')).toBeNull();
    expect(nextShot(shots, 'SH002')?.key).toBe('SH003');
    expect(nextShot(shots, 'SH003')).toBeNull();
    expect(moved(['SH001', 'SH002', 'SH003'], 'SH002', -1)).toEqual(['SH002', 'SH001', 'SH003']);
    expect(moved(['SH001', 'SH002'], 'SH002', 1)).toBeNull();
    expect(moved(['SH001', 'SH002'], 'SH009', 1)).toBeNull();
  });

  it('let a class only be lowered', () => {
    expect(lowerClasses('DOCUMENTED')).toEqual(['RECONSTRUCTION', 'UNCERTAIN']);
    expect(lowerClasses('UNCERTAIN')).toEqual([]);
    expect(lowerClasses('FICTION')).toEqual([]);
    expect(lowerClasses(null)).toEqual([]);
  });

  it('send only what changed, never the depiction, the automatic labels or a raised class', () => {
    const s = shot();
    const f = shotForm(s);
    expect(f.overlays).toEqual([]);
    expect(shotPatch(s, f)).toBeNull();
    expect(shotPatch(s, { ...f, description: '  The quay at first light.  ' })).toEqual({ description: 'The quay at first light.' });
    expect(shotPatch(s, { ...f, treatment: 'TEXT_ON_SCREEN', method: 'EDIT_TIME' })).toEqual({ treatment: 'TEXT_ON_SCREEN', method: 'EDIT_TIME' });
    expect(shotPatch(s, { ...f, infoClass: 'DOCUMENTED' })).toBeNull();
    expect(shotPatch(s, { ...f, infoClass: 'UNCERTAIN' })).toEqual({ infoClass: 'UNCERTAIN' });
    expect(shotPatch(s, { ...f, uncertaintyDevice: 'LABELLED_LEGEND', overlays: [{ kind: 'CAPTION', text: ' As the story is told ', reason: 'legend', claimKeys: [], auto: false }] })).toEqual({
      uncertaintyDevice: 'LABELLED_LEGEND',
      overlays: [{ kind: 'CAPTION', text: 'As the story is told', reason: 'legend', claimKeys: [], auto: false }],
    });
    expect(shotPatch(s, { ...f, addMustAvoid: 'cars\n\ncars\nmodern clothing\n neon ' })).toEqual({
      mustAvoid: [
        { text: 'modern clothing', origin: 'SCRIPT' },
        { text: 'cars', origin: 'STORYBOARD' },
        { text: 'neon', origin: 'STORYBOARD' },
      ],
    });
    expect(shotPatch(s, { ...f, camera: { angle: 'low', lens: ' ' }, environment: 'The quay.', claims: [{ claimKey: ' C3 ', role: 'CONTEXT' }, { claimKey: '', role: 'DEPICTS' }] })).toEqual({
      camera: { angle: 'low', lens: null },
      environment: { subjectKey: 'CS01', description: 'The quay.' },
      claims: [{ claimKey: 'C3', role: 'CONTEXT' }],
    });
    for (const p of [shotPatch(s, { ...f, mood: 'Tense.' })!]) expect(p).not.toHaveProperty('depiction');
  });

  it('edit specific details, objects and subjects: whole lists when any changed, each detail with its basis', () => {
    const real = { subjectKey: 'CS02', name: 'The inquiry chair', kind: 'CHARACTER' as const, castKind: 'REAL_PERSON' as const, detail: { role: 'PRIMARY' as const, action: 'reads the verdict', interactions: [{ withSubjectKey: 'CS03', kind: 'SPEAKS_TO' as const }], likeness: 'GENERATED_LIKENESS' as const, speaks: { kind: 'RECORDED_QUOTE' as const, claimKey: 'C7' } } };
    const extra = { subjectKey: 'CS03', name: 'A clerk', kind: 'CHARACTER' as const, castKind: null, detail: { role: 'BACKGROUND' as const, action: '', interactions: [], likeness: 'PERIOD_GENERIC' as const, speaks: null } };
    const s = shot({
      spec: { ...shot().spec, specifics: [{ detail: 'A naval uniform', kind: 'UNIFORM', basis: 'INVENTED', claimKeys: [] }], objects: [{ name: 'The report', basis: 'CLAIM', claimKeys: ['C7'] }] },
      subjects: [real, extra],
    });
    const f = shotForm(s);
    expect(f.specifics).toEqual([{ detail: 'A naval uniform', kind: 'UNIFORM', basis: 'INVENTED', claimKeys: '' }]);
    expect(f.objects).toEqual([{ name: 'The report', basis: 'CLAIM', claimKeys: 'C7' }]);
    expect(shotPatch(s, f)).toBeNull();
    // The form's subjects are its own: editing them leaves the shot as it was.
    f.subjects[0]!.detail.interactions[0]!.kind = 'OBSERVES';
    expect(real.detail.interactions[0]!.kind).toBe('SPEAKS_TO');
    const g = shotForm(s);
    // An invented detail in a documented shot is removed; a generated likeness of a real person becomes a silhouette.
    expect(
      shotPatch(s, {
        ...g,
        specifics: [{ detail: ' ', kind: 'OTHER', basis: 'INVENTED', claimKeys: '' }],
        subjects: [{ subjectKey: 'CS02', detail: { ...g.subjects[0]!.detail, likeness: 'SILHOUETTE', action: ' reads the verdict  ', speaks: null } }, g.subjects[1]!],
      }),
    ).toEqual({
      specifics: [],
      subjects: [
        { subjectKey: 'CS02', detail: { role: 'PRIMARY', action: 'reads the verdict', interactions: [{ withSubjectKey: 'CS03', kind: 'SPEAKS_TO' }], likeness: 'SILHOUETTE', speaks: null } },
        { subjectKey: 'CS03', detail: extra.detail },
      ],
    });
    expect(shotPatch(s, { ...g, subjects: [g.subjects[1]!] })).toEqual({ subjects: [{ subjectKey: 'CS03', detail: extra.detail }] });
    expect(shotPatch(s, { ...g, objects: [{ name: 'The report', basis: 'CLAIM', claimKeys: 'C7, C8' }] })).toEqual({ objects: [{ name: 'The report', basis: 'CLAIM', claimKeys: ['C7', 'C8'] }] });
    // A detail or object said to rest on a claim names it before it is sent.
    expect(shotFormProblems(g)).toEqual([]);
    expect(shotFormProblems({ specifics: [{ detail: 'A guild seal', kind: 'DOCUMENT', basis: 'CLAIM', claimKeys: ' ' }], objects: [{ name: 'A ledger', basis: 'CLAIM', claimKeys: '' }, { name: '', basis: 'CLAIM', claimKeys: '' }] })).toEqual([
      '“A guild seal” rests on a claim: name it, or mark it generic for the period or invented',
      '“A ledger” rests on a claim: name it, or mark it generic for the period or invented',
    ]);
  });
});

describe('continuity', () => {
  it('edit design details with their basis: claim keys typed as a list, empty rows dropped, a claim basis naming its claim', () => {
    const details = [
      { detail: 'Barrels by the doors', basis: 'PERIOD_GENERIC' as const, claimKeys: [] },
      { detail: 'The 1637 ledger', basis: 'CLAIM' as const, claimKeys: ['C3', 'C4'] },
    ];
    const rows = detailRows(details);
    expect(rows).toEqual([
      { detail: 'Barrels by the doors', basis: 'PERIOD_GENERIC', claimKeys: '' },
      { detail: 'The 1637 ledger', basis: 'CLAIM', claimKeys: 'C3, C4' },
    ]);
    // Read back unchanged: the form sends nothing for them.
    expect(designDetailsFrom(rows)).toEqual({ details, problems: [] });
    const edited = designDetailsFrom([...rows, { detail: '  ', basis: 'INVENTED', claimKeys: '' }, { detail: ' A red sash ', basis: 'INVENTED', claimKeys: '' }]);
    expect(edited).toEqual({ details: [...details, { detail: 'A red sash', basis: 'INVENTED', claimKeys: [] }], problems: [] });
    expect(designDetailsFrom([{ detail: 'The guild seal', basis: 'CLAIM', claimKeys: ' , ' }]).problems).toEqual(['“The guild seal” rests on a claim: name it, or mark it generic for the period or invented']);
  });
});

describe('visual profiles', () => {
  it('read every setting, marking what the project overrode', () => {
    const rows = visualConfigRows({ ...DEFAULT_VISUAL_PROFILE_CONFIG, density: 'SPARSE', providerPreferences: { GENERATIVE_VIDEO: [{ provider: 'acme-video', model: 'acme-v1' }] } }, { density: 'PROJECT', 'generation.maxGeneratedVideoShare': 'PROJECT' });
    const row = (path: string) => rows.find((r) => r.path === path)!;
    expect(rows).toHaveLength(17);
    expect(row('density')).toEqual({ path: 'density', label: 'Visual density', value: 'Sparse (long shots)', source: 'PROJECT' });
    expect(row('generation').source).toBe('PROJECT');
    expect(row('generation').value).toBe('generated video at most 50% of the runtime');
    expect(row('realism').source).toBe('PROFILE');
    expect(row('providerPreferences').value).toBe('Generated video: acme-video acme-v1');
    expect(row('costCeilingUsd').value).toBe('no ceiling in all; no ceiling a finished minute');
    expect(visualConfigRows(DEFAULT_VISUAL_PROFILE_CONFIG).find((r) => r.path === 'providerPreferences')!.value).toBe('none (the catalog order)');
  });

  it('say how a version was made, and which settings a project overrides', () => {
    expect(visualOriginText({ kind: 'PRESET', preset: 'cinematic-history' })).toBe('a seeded preset (cinematic-history)');
    expect(visualOriginText({ kind: 'EDIT', basedOnVersion: 2 })).toBe('an edit of v2');
    expect(visualOriginText({ kind: 'LIBRARY' })).toBe('made in the library');
    expect(describeVisualOverrides({})).toBe('none');
    expect(describeVisualOverrides({ density: 'DENSE', generation: {}, approach: 'B' })).toBe('density, approach');
  });
});

describe('planning a storyboard', () => {
  const assembly = (over: Partial<StoryboardInputsView['runs'][number]['assemblies'][number]> = {}) => ({
    id: 'as-2',
    version: 2,
    status: 'IN_REVIEW' as const,
    complete: false,
    totalDurationMs: 109_800,
    fingerprint: 'f',
    takes: { approved: 4, total: 11 },
    mock: false,
    approval: 'UNREVIEWED' as const,
    gateApproved: false,
    ...over,
  });
  const run = (over: Partial<StoryboardInputsView['runs'][number]> = {}) => ({ id: 'run-3', number: 3, kind: 'AUDITION' as const, label: 'Audition — run 3', variant: null, scopeBlockKeys: ['1.1'], current: true, assemblies: [assembly(), assembly({ id: 'as-1', version: 1 })], ...over });
  const p = (status: ProjectDetailView['status'], failedFromStatus: ProjectDetailView['failedFromStatus'] = null) => ({ status, failedFromStatus });

  it('queue the phase job only on the narration the VOICE gate approved, a preview while the narration is reviewed, nothing after', () => {
    expect(planKind(p('VOICE_REVIEW'), { gateApproved: false })).toEqual({ kind: 'PREVIEW', reason: null });
    expect(planKind(p('VOICE_COMPLETE'), { gateApproved: true })).toEqual({ kind: 'PHASE', reason: null });
    expect(planKind(p('VOICE_COMPLETE'), { gateApproved: false })).toEqual({ kind: 'PREVIEW', reason: null });
    expect(planKind(p('FAILED', 'VISUAL_PLANNING'), { gateApproved: true }).kind).toBe('PHASE');
    expect(planKind(p('STORYBOARD_REVIEW'), { gateApproved: false })).toEqual({ kind: null, reason: 'In “Storyboard review” the storyboard is planned on the film’s approved narration' });
    expect(planKind(p('SCRIPT_APPROVED'), { gateApproved: false }).reason).toMatch(/^A storyboard is planned while the narration is reviewed or after it is approved, and before visual generation \(the project is “/);
    expect(planKind(p('VISUAL_GENERATING'), { gateApproved: true }).kind).toBeNull();
    expect(phaseOpen(p('STORYBOARD_APPROVED'))).toBe(true);
    expect(phaseOpen(p('VOICE_REVIEW'))).toBe(false);
    expect(phaseOpen(p('FAILED', 'VOICE_GENERATING'))).toBe(false);
  });

  it('offer the gate-approved narration while the phase is open, else the newest run of the approved script at its latest assembly', () => {
    const older = run({ id: 'run-2', number: 2, assemblies: [assembly({ id: 'gate', version: 1, gateApproved: true })] });
    const stale = run({ id: 'run-4', number: 4, current: false });
    expect(planDefaults(p('VOICE_REVIEW'), { runs: [stale, run(), older] })).toEqual({ runId: 'run-3', assemblyId: 'as-2' });
    expect(planDefaults(p('VOICE_COMPLETE'), { runs: [stale, run(), older] })).toEqual({ runId: 'run-2', assemblyId: 'gate' });
    expect(planDefaults(p('VOICE_REVIEW'), { runs: [stale, run({ assemblies: [] })] })).toBeNull();
    // The run named on the page comes first, then the gate's narration while the phase is open, then the project's chosen run.
    expect(planDefaults(p('VOICE_REVIEW'), { runs: [stale, run(), older] }, null, 2)).toEqual({ runId: 'run-2', assemblyId: 'gate' });
    expect(planDefaults(p('VOICE_COMPLETE'), { runs: [stale, run(), older] }, 3)).toEqual({ runId: 'run-3', assemblyId: 'as-2' });
    expect(planDefaults(p('VOICE_COMPLETE'), { runs: [stale, run(), older] }, null, 3)).toEqual({ runId: 'run-2', assemblyId: 'gate' });
    expect(planDefaults(p('VOICE_COMPLETE'), { runs: [stale, run(), older] }, 2)).toEqual({ runId: 'run-2', assemblyId: 'gate' });
    // A named or chosen run of another script, or not assembled, is passed over.
    expect(planDefaults(p('VOICE_REVIEW'), { runs: [stale, run(), older] }, 4, 4)).toEqual({ runId: 'run-3', assemblyId: 'as-2' });
    expect(planDefaults(p('VOICE_REVIEW'), { runs: [run({ id: 'run-5', number: 5, assemblies: [] }), older] }, 5)).toEqual({ runId: 'run-2', assemblyId: 'gate' });
    expect(planRunText({ number: 3, variant: 'C expressive', label: 'Audition — run 3' }, assembly({ takes: { approved: 11, total: 11 } }), true)).toBe('Voice run 3 · C expressive · 11/11 takes approved · 1:50 · ★ your chosen run');
    expect(planRunText({ number: 5, variant: null, label: 'Audition — run 5' }, null)).toBe('Voice run 5 · Audition — run 5 · not assembled');
    expect(assemblyText(assembly())).toBe('Assembly v2 · 1:49.8 · takes 4/11 approved');
    expect(assemblyText(assembly({ gateApproved: true, complete: true, mock: true }))).toBe('Assembly v2 · 1:49.8 · takes 4/11 approved · the film’s approved narration · the whole script · mock audio');
  });
});

describe('decisions and versions', () => {
  const lane = (approved: number, total = 3) => ({ totalDurationMs: 9000, blocks: [], silences: [], takes: Array.from({ length: total }, (_, i) => ({ generationId: `g${i}`, chunkIndex: i, status: i < approved ? ('APPROVED' as const) : ('IN_REVIEW' as const), startMs: i * 3000, endMs: i * 3000 + 2900, audioUrl: null })) });
  const qa = (...severities: ('BLOCKING' | 'WARNING')[]) => ({ saved: [], live: severities.map((severity) => ({ kind: 'UNCERTAIN_AS_FACT' as const, severity, ref: 'SH001', detail: 'd' })) });
  const narration = (approval: 'GATE_APPROVED' | 'TAKES_APPROVED' | 'UNREVIEWED') => ({ runId: 'r', runNumber: 3, runKind: 'AUDITION' as const, assemblyId: 'a', assemblyVersion: 1, approval });

  it('say why a version cannot be approved: live blocking findings, rejected shots, takes not all approved', () => {
    expect(approvalNeeds({ scope: 'PARTIAL', qa: qa('WARNING'), shots: [shot({ review: 'APPROVED' })], narration: narration('TAKES_APPROVED'), narrationLane: lane(3) })).toEqual([]);
    expect(
      approvalNeeds({ scope: 'PARTIAL', qa: qa('BLOCKING', 'BLOCKING', 'WARNING'), shots: [shot({ key: 'SH002', review: 'REJECTED' }), shot({ key: 'SH004', review: 'REJECTED' })], narration: narration('UNREVIEWED'), narrationLane: lane(1) }),
    ).toEqual(['2 blocking findings to resolve (see QA)', 'SH002, SH004 are rejected: edit them, or clear the decision', 'approve the takes it is timed on first (1/3 approved, on the Voice page)']);
    expect(approvalNeeds({ scope: 'PARTIAL', qa: qa('BLOCKING'), shots: [shot({ review: 'REJECTED' })], narration: narration('GATE_APPROVED'), narrationLane: lane(3) })).toEqual(['1 blocking finding to resolve (see QA)', 'SH001 is rejected: edit it, or clear the decision']);
  });

  it('pass a whole-script version at the gate only on the narration the VOICE gate approved, approved takes or not', () => {
    const gateLine = 'plan it on the film’s approved narration: the film’s storyboard is approved only on that narration';
    expect(approvalNeeds({ scope: 'FULL', qa: qa(), shots: [shot()], narration: narration('GATE_APPROVED'), narrationLane: lane(3) })).toEqual([]);
    expect(approvalNeeds({ scope: 'FULL', qa: qa(), shots: [shot()], narration: narration('TAKES_APPROVED'), narrationLane: lane(3) })).toEqual([gateLine]);
    expect(approvalNeeds({ scope: 'FULL', qa: qa(), shots: [shot()], narration: narration('UNREVIEWED'), narrationLane: lane(1) })).toEqual([gateLine]);
  });

  it('list what a version changed from its base, field by field', () => {
    expect(changesLines(null)).toEqual([]);
    const none = { baseVersion: 2, shots: { added: [], removed: [], changed: [] }, beats: { added: [], removed: [], changed: [] } };
    expect(changesLines(none)).toEqual(['No change from v2']);
    expect(
      changesLines({ baseVersion: 1, shots: { added: ['SH017'], removed: ['SH003', 'SH004'], changed: [{ shotKey: 'SH005', fields: ['treatment', 'description'] }] }, beats: { added: [], removed: [], changed: [{ beatKey: 'VB02', fields: ['title'] }] } }),
    ).toEqual(['Shots added: SH017', 'Shots removed: SH003, SH004', 'SH005 changed: treatment, description', 'VB02 changed: title']);
  });
});

describe('costs, evidence and rhythm', () => {
  it('read rates per unit, and a card with no rate as not priced whatever confidence it states', () => {
    expect(rateText({ unit: 'VIDEO_SECONDS', usdPerUnit: 0.168 })).toBe('$0.168 a second of video');
    expect(rateText({ unit: 'IMAGES', usdPerUnit: 0.0057 })).toBe('$0.0057 an image');
    expect(rateText({ unit: 'REQUESTS', usdPerUnit: 25 })).toBe('$25 an item');
    // A priced fraction too small for four decimals keeps its digits: a price is never read as $0.
    expect(rateText({ unit: 'INPUT_TOKENS', usdPerUnit: 0.000003 })).toBe('$0.000003 per input tokens');
    expect(rateText({ unit: 'CREDITS', usdPerUnit: 0.0000456789 })).toBe('$0.0000457 a credit');
    expect(rateText({ unit: 'VIDEO_SECONDS', usdPerUnit: 0 })).toBe('$0 a second of video');
    const rows = pricingRows({
      catalogVersion: '2026-10-06.2',
      cards: [
        {
          provider: 'acme-video',
          model: 'acme-v1',
          label: 'Acme v1',
          methods: ['GENERATIVE_VIDEO', 'IMAGE_TO_VIDEO'],
          rates: [
            { model: 'acme-v1', unit: 'VIDEO_SECONDS', usdPerUnit: 0.1125, source: 'acme list' },
            { model: 'acme-v1', unit: 'IMAGES', usdPerUnit: 0.0057, source: 'acme still page' },
            { model: 'acme-v1', unit: 'IMAGES', usdPerUnit: 0.0057, source: 'acme still page' },
          ],
          source: 'acme list',
          checkedAt: '2026-10-07',
          confidence: 'ASSUMPTION',
        },
        { provider: 'archive', model: 'item', label: 'Archive item', methods: ['ARCHIVAL_SOURCING'], rates: [], source: 'no price', checkedAt: '2026-10-07', confidence: 'ASSUMPTION' },
      ],
    });
    expect(rows.map((r) => [r.key, r.methods, r.rates, r.sure])).toEqual([
      ['acme-video/acme-v1', 'Generated video, Generated still, animated', '$0.1125 a second of video; $0.0057 an image; $0.0057 an image', 'Assumption'],
      ['archive/item', 'Archival sourcing', 'not priced', 'not priced'],
    ]);
    // Each rate's own source, where it names another page than the card's, once.
    expect(rows.map((r) => [r.source, r.rateSources])).toEqual([
      ['acme list', ['acme still page']],
      ['no price', []],
    ]);
  });

  it('list each shot’s forecast in clock order, an unpriced shot never as $0', () => {
    const rows = shotCostRows([
      shot({ key: 'SH002', startMs: 4000, treatment: 'ARCHIVAL_IMAGE', method: 'ARCHIVAL_SOURCING', cost: estimate({ method: 'ARCHIVAL_SOURCING', basis: 'UNPRICED', totalUsd: null, perGenerationUsd: null, confidence: null, lines: [] }) }),
      shot({ key: 'SH001', cost: estimate() }),
      shot({ key: 'SH003', startMs: 8000, treatment: null, method: null, cost: null }),
      // A shot reusing another's asset costs nothing of its own and needs no provider for that reason.
      shot({
        key: 'SH004',
        startMs: 12000,
        cost: estimate({ provider: null, model: null, lines: [], perGenerationUsd: 0, totalUsd: 0, confidence: null, note: "Reuses SH001's asset: no generation of its own" }),
        assetRequirement: { assetType: 'IMAGE', method: 'GENERATIVE_IMAGE', sourcing: 'GENERATE', durationSec: 4, aspectRatio: '16:9', resolution: '1080p', references: [], licensing: { status: 'NOT_APPLICABLE', note: '' }, reuse: { reusable: true, reuseKey: 'quay', category: 'ENVIRONMENT', subjects: [], location: null, era: null, style: { profileId: 'p', version: 1 }, claimKeys: [], projectId: 'p1', provider: null, model: null, source: null, promptVersion: null }, reuseOf: 'SH001' },
      }),
      shot({ key: 'SH005', startMs: 16000, method: 'EDIT_TIME', cost: estimate({ method: 'EDIT_TIME', provider: null, model: null, lines: [], perGenerationUsd: 0, totalUsd: 0, confidence: null }) }),
    ]);
    expect(rows.map((r) => [r.key, r.method, r.recommendation, r.generations, r.estimate])).toEqual([
      ['SH001', 'Generated image', 'acme-video acme-v1', '2.5', '~$2.25'],
      ['SH002', 'Archival sourcing', 'acme-video acme-v1', '—', 'unpriced'],
      ['SH003', '—', 'no provider needed', '—', 'no forecast'],
      ['SH004', 'Generated image', "reuses SH001's asset", '—', '~$0.00'],
      ['SH005', 'Made in the edit', 'no provider needed', '—', '~$0.00'],
    ]);
  });

  it('mark each shot traced, untraced or showing no fact, with its sources counted once', () => {
    const claim = (key: string, role: 'DEPICTS' | 'CONTEXT', sourceIds: string[]) => ({ claimId: key, key, statement: 's', role, verdict: 'ESTABLISHED' as const, savedVerdict: null, confidence: 'HIGH' as const, presentation: null, sourceIds });
    const reconstructed = (over: Partial<ShotView>) => shot({ ...over, infoClass: 'DOCUMENTED', spec: { ...shot().spec, depiction: 'RECONSTRUCTED' } });
    const rows = evidenceRows({
      shots: [
        shot({ key: 'SH003', startMs: 8000, claims: [claim('C2', 'DEPICTS', [])] }),
        shot({ key: 'SH001', claims: [claim('C1', 'DEPICTS', ['s1']), claim('C9', 'CONTEXT', ['s1', 's2'])] }),
        shot({ key: 'SH002', startMs: 4000, claims: [claim('C9', 'CONTEXT', ['s2'])] }),
        // A documented event reconstructed on a context claim is a factual visual, traced as the coverage counts it.
        reconstructed({ key: 'SH004', startMs: 12000, claims: [claim('C9', 'CONTEXT', ['s2'])] }),
        reconstructed({ key: 'SH005', startMs: 16000, unplanned: true, infoClass: null }),
      ],
      evidenceCoverage: { untraced: ['SH003'] },
    });
    expect(rows.map((r) => [r.shot.key, r.state, r.sources])).toEqual([
      ['SH001', 'TRACED', 2],
      ['SH002', 'NOT_FACTUAL', 1],
      ['SH003', 'UNTRACED', 0],
      ['SH004', 'TRACED', 1],
      ['SH005', 'NOT_FACTUAL', 0],
    ]);
    // The same definition as the coverage: a factual class shown as a record, a reconstruction or data, or any asserting claim.
    expect(factualShot(shot({ infoClass: 'UNCERTAIN', spec: { ...shot().spec, depiction: 'DATA' } }))).toBe(true);
    expect(factualShot(shot({ infoClass: 'FRAMING', spec: { ...shot().spec, depiction: 'RECONSTRUCTED' } }))).toBe(false);
    expect(factualShot(shot({ infoClass: 'FICTION', spec: { ...shot().spec, depiction: 'FICTIONAL' }, claims: [claim('C1', 'DEPICTS', [])] }))).toBe(true);
  });

  it('say the forecast a finished minute counts the priced shots only', () => {
    expect(perMinuteText({ perFinishedMinute: null, unpricedShots: 3 })).toBeNull();
    expect(perMinuteText({ perFinishedMinute: 12.5, unpricedShots: 0 })).toBe('About ~$12.50 a finished minute.');
    expect(perMinuteText({ perFinishedMinute: 4, unpricedShots: 2 })).toBe('About ~$4.00 a finished minute (the priced shots only; 2 unpriced).');
  });

  it('hold visual generation, its retries included, while the storyboard is real', () => {
    expect(generationHeld(['VISUAL_PLAN', 'STORYBOARD_PREVIEW'], 'VISUAL_GENERATION')).toBe(true);
    expect(generationHeld(['VISUAL_PLAN'], 'INFOGRAPHIC')).toBe(true);
    expect(generationHeld(['VISUAL_PLAN'], 'VISUAL_PLAN')).toBe(false);
    expect(generationHeld(['VISUAL_PLAN'], 'EDIT')).toBe(false);
    // The all-mock pipeline keeps its full walk.
    expect(generationHeld(['SCRIPT', 'VOICE'], 'VISUAL_GENERATION')).toBe(false);
  });

  it('read the rhythm as rows', () => {
    const r: RhythmStats = {
      shots: 16,
      averageShotMs: 6862,
      medianShotMs: 6100,
      minShotMs: 2400,
      maxShotMs: 12_900,
      cutsPerMinute: 8.74,
      treatmentChanges: 12,
      longestSameTreatmentRun: 1,
      staticShare: 0.25,
      movingShare: 0.75,
      claimsPerMinute: 3,
      overlaysPerMinute: 0.5,
      resetPoints: [{ atMs: 31_200, kind: 'TIME_JUMP', ref: '1.4' }],
      peaks: [{ atMs: 64_000, beatKey: 'VB07', kind: 'QUESTION_POSED' }],
      reveals: 1,
      transitions: 2,
      generatedVideoShare: 0.31,
    };
    const rows = new Map(rhythmRows(r).map((x) => [x.label, x.value]));
    expect(rows.get('Average shot')).toBe('6.9 s');
    expect(rows.get('Shortest – longest')).toBe('2.4 s – 12.9 s');
    expect(rows.get('Cuts a minute')).toBe('8.7');
    expect(rows.get('Longest run of one treatment')).toBe('1 shot');
    expect(rows.get('Static · moving')).toBe('25% · 75%');
    expect(rows.get('Generated video')).toBe('31% of the runtime');
    expect(rows.get('Reset points')).toBe('0:31.2 time jump');
    expect(rows.get('Peaks')).toBe('1:04.0 VB07 question posed');
    expect(rhythmRows({ ...r, resetPoints: [], peaks: [] }).find((x) => x.label === 'Peaks')!.value).toBe('none');
  });
});

describe('visual profile forms', () => {
  it('edit every setting of a profile, one field or row each', () => {
    const paths = [...VISUAL_FIELDS.map((f) => f.path), ...VISUAL_ROW_PATHS];
    const leaves = (o: Record<string, unknown>, at = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => {
        const path = at ? `${at}.${k}` : k;
        return paths.includes(path) ? [path] : v !== null && typeof v === 'object' && !Array.isArray(v) ? leaves(v as Record<string, unknown>, path) : [path];
      });
    expect(leaves(DEFAULT_VISUAL_PROFILE_CONFIG).sort()).toEqual([...paths].sort());
    for (const f of VISUAL_FIELDS.filter((x) => x.kind === 'choice')) expect(f.options!.map((o) => o.value)).toContain(valueAt(DEFAULT_VISUAL_PROFILE_CONFIG, f.path));
  });

  it('read and set a setting by its path without changing the original', () => {
    const c = DEFAULT_VISUAL_PROFILE_CONFIG;
    const next = withValue(c, 'cameraLanguage.style', 'HANDHELD');
    expect(valueAt(next, 'cameraLanguage.style')).toBe('HANDHELD');
    expect(valueAt(next, 'cameraLanguage.note')).toBe(c.cameraLanguage.note);
    expect(c.cameraLanguage.style).not.toBe('HANDHELD');
    expect(valueAt(c, 'colour.nothing.deeper')).toBeUndefined();
    expect(withValue({}, 'generation.rerolls', { GENERATIVE_VIDEO: 2 })).toEqual({ generation: { rerolls: { GENERATIVE_VIDEO: 2 } } });
  });

  it('send only what a form changed, as overrides the contract takes', () => {
    const base = DEFAULT_VISUAL_PROFILE_CONFIG;
    expect(configChanges(base, structuredClone(base) as VisualStyleProfileConfig)).toEqual({});
    let next = withValue(base, 'density', 'SPARSE');
    next = withValue(next, 'generation.maxGeneratedVideoShare', 0.3);
    next = withValue(next, 'providerPreferences', { GENERATIVE_VIDEO: [{ provider: 'acme-video', model: 'acme-v1' }] });
    next = withValue(next, 'costCeilingUsd.total', 40);
    const changes = configChanges(base, next);
    expect(changes).toEqual({ density: 'SPARSE', generation: { maxGeneratedVideoShare: 0.3 }, providerPreferences: { GENERATIVE_VIDEO: [{ provider: 'acme-video', model: 'acme-v1' }] }, costCeilingUsd: { total: 40 } });
    expect(VisualConfigOverrides.safeParse(changes).success).toBe(true);
    // The same rerolls built in another key order are no change.
    const a = withValue(base, 'generation.rerolls', { GENERATIVE_VIDEO: 2, STILL_MOTION: 1 });
    expect(configChanges(a, withValue(base, 'generation.rerolls', { STILL_MOTION: 1, GENERATIVE_VIDEO: 2 }))).toEqual({});
    expect(sameSettings({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
  });

  it('turn a project’s overrides into paths for the form and back, losing none', () => {
    const o: VisualConfigOverrides = { density: 'DENSE', cameraLanguage: { note: 'Steady.' }, generation: { rerolls: { GENERATIVE_VIDEO: 2 }, preferStillMotion: true }, providerPreferences: {}, costCeilingUsd: { total: null } };
    const paths = overridePaths(o);
    expect(paths).toEqual({ density: 'DENSE', 'cameraLanguage.note': 'Steady.', 'generation.rerolls': { GENERATIVE_VIDEO: 2 }, 'generation.preferStillMotion': true, providerPreferences: {}, 'costCeilingUsd.total': null });
    expect(overridesFrom(paths)).toEqual(o);
    expect(overridesFrom({ density: undefined })).toEqual({});
  });

  it('read typed lists, shares and dollars, refusing what is not one', () => {
    expect(wordsOf(' 35mm, ,50mm ,')).toEqual(['35mm', '50mm']);
    expect(shareOf('25')).toBe(0.25);
    expect(shareOf('33.5')).toBe(0.335);
    expect(shareOf('101')).toBeUndefined();
    expect(shareOf('')).toBeUndefined();
    expect(usdOf('')).toBeNull();
    expect(usdOf('12.5')).toBe(12.5);
    expect(usdOf('-1')).toBeUndefined();
    expect(usdOf('ten')).toBeUndefined();
  });

  it('say what a project plans with now', () => {
    expect(productionText({ mode: 'DEFAULT', family: { name: 'Cinematic History' }, profile: { version: 1 }, newer: null })).toBe('Cinematic History v1 · the library default');
    expect(productionText({ mode: 'FOLLOW', family: { name: 'Dark True Crime' }, profile: { version: 3 }, newer: null })).toBe('Dark True Crime v3 · follows its current version');
    expect(productionText({ mode: 'PIN', family: { name: 'Dark True Crime' }, profile: { version: 1 }, newer: { version: 3 } })).toBe('Dark True Crime v1 · pinned to v1 (v3 available)');
    expect(productionText({ mode: 'DEFAULT', family: null, profile: null, newer: null })).toMatch(/^none yet/);
  });
});

describe("status note in the viewer's time zone", () => {
  const saved = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Australia/Brisbane';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
  const at = '2026-10-09T23:56:12.000Z'; // the production approval: 10 Oct, 09:56 in UTC+10
  const approved = { decision: 'APPROVED', decidedBy: 'admin', createdAt: at } as unknown as StoryboardDecisionView;

  it('dates an approval as the Approval hint and the Versions list do', () => {
    expect(new Date(at).getDate()).toBe(10); // the zone switch took effect
    const note = statusNoteText({ version: 1, status: 'APPROVED', decidedBy: 'admin', decidedAt: at, newer: { version: 2, status: 'IN_REVIEW', changedShots: 1 }, decisions: [approved], supersededBy: null });
    expect(note).toBe(`Approved by admin on ${formatDate(at)}; the approval applies to v1: v2 differs in 1 shot(s)`);
    expect(note).not.toContain('2026-10-09');
  });

  it("dates the supersede in the viewer's zone, with and without a decision", () => {
    const later = '2026-10-09T23:59:00.000Z';
    expect(statusNoteText({ version: 1, status: 'SUPERSEDED', decidedBy: 'admin', decidedAt: at, newer: null, decisions: [approved], supersededBy: { version: 3, at: later } })).toBe(
      `Approved by admin on ${formatDate(at)}, superseded by v3 on ${formatDate(later)}`,
    );
    expect(statusNoteText({ version: 2, status: 'SUPERSEDED', decidedBy: null, decidedAt: null, newer: null, decisions: [], supersededBy: { version: 3, at: later } })).toBe(`Superseded by v3 on ${formatDate(later)}`);
  });
});
