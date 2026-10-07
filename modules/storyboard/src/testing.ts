import {
  DEFAULT_VISUAL_PRESET,
  SCOPE_END,
  SCOPE_START,
  VISUAL_PROFILE_PRESETS,
  beatKey,
  shotKey,
  type ContinuitySpec,
  type NarrationApproval,
  type NarrationSpine,
  type ProductionMethod,
  type Rate,
  type StoryboardScope,
  type VisualApproach,
  type VisualBeatContent,
  type VisualCatalog,
  type VisualIntent,
  type VisualProfileSnapshot,
  type VisualProviderCard,
  type VisualStyleProfileConfig,
  type VisualTreatment,
} from '@docengine/core';
import { ARCHIVAL_CARD, IN_HOUSE_CARD, MOCK_VISUAL_CARD, ProviderError, STOCK_CARD, clipLengths, visualModel, type ObjectGenerationRequest, type ObjectGenerationResult } from '@docengine/providers';
import type { ScriptDraft, ScriptScope } from '@docengine/script';
import { FakeScriptAI, syntheticDraft, syntheticScope, type SyntheticSpec } from '@docengine/script/testing';
import { syntheticAssembly, type SyntheticAssemblyOptions } from '@docengine/voice/testing';
import { emptyContent, type DraftBeat, type DraftShot, type DraftSubject, type ShotContent, type StoryboardDraft, type StoryboardFacts } from './draft.ts';
import type { BeatsOutput, RepairOutput, ShotOutput, ShotsOutput } from './schemas.ts';
import { buildSpine } from './spine.ts';

/**
 * Fixtures for the storyboard's tests: narration timed on a real assembly
 * clock (built by the voice engine's own assemble()), a synthetic visual
 * catalog of made-up vendors (acme-*), profile snapshots, five synthetic
 * films from different domains, and a scripted AI for the planning calls.
 * Nothing here calls a provider.
 */

/** The script with row ids, as a version loaded from its rows has them ("scene-SC01", "b1.3"). */
export function withRowIds(script: ScriptDraft): ScriptDraft {
  return {
    ...script,
    sections: script.sections.map((s) => ({ ...s, rowId: s.rowId ?? `scene-${s.key}`, blocks: s.blocks.map((b) => ({ ...b, rowId: b.rowId ?? `b${b.key}` })) })),
  };
}

export interface SyntheticSpineOptions extends Omit<SyntheticAssemblyOptions, 'chunks'> {
  /** Narrate only these blocks (default: every block of the script). */
  blocks?: string[];
  /** Blocks narrated together, one list per chunk (default: a chunk per block). */
  chunks?: string[][];
}

/** The narration of a script (or some of its blocks) as the storyboard reads it: a real assembly clock with real word times. */
export function syntheticSpine(script: ScriptDraft, o: SyntheticSpineOptions = {}): NarrationSpine {
  const keyed = withRowIds(script);
  const only = o.blocks ? new Set(o.blocks) : null;
  const blocks = keyed.sections.flatMap((s) => s.blocks.filter((b) => !only || only.has(b.key)).map((b) => ({ key: b.key, sectionKey: s.key, text: b.text, id: b.rowId! })));
  const { blocks: _ignored, ...rest } = o;
  return syntheticAssembly(blocks, { ...rest, ids: { script: 'script-1', ...o.ids } }).spine;
}

// ── The visual catalog (made-up vendors) ─────────────────────────────────────

const CHECKED = '2026-10-07';
const ALL_FRAMES = ['16:9', '9:16', '1:1', '4:3', '21:9'] as const;
const RESOLUTIONS = ['1080p', '1440p', '2160p'] as const;

const rate = (provider: string, model: string, unit: Rate['unit'], usd: number, note: string): Rate => ({ provider, model, unit, usdPerUnit: usd, source: `https://example.com/${provider}/pricing (checked ${CHECKED}; ${note})` });

/** Billed by the second, $0.1125/s, with a still at $0.03 for image to video: the brief's own example (8 s × $0.1125 = $0.90 a generation). */
export const ACME_VIDEO: VisualProviderCard = {
  provider: 'acme-video',
  label: 'Acme Video (test)',
  implemented: false,
  models: [visualModel('acme-video', { model: 'acme-motion-1', label: 'Acme Motion 1', methods: ['GENERATIVE_VIDEO', 'IMAGE_TO_VIDEO'], aspectRatios: ALL_FRAMES, resolutions: RESOLUTIONS, clip: null })],
  rates: [rate('acme-video', 'acme-motion-1', 'VIDEO_SECONDS', 0.1125, 'list price per second'), rate('acme-video', 'acme-motion-1', 'IMAGES', 0.03, 'the source still')],
  pricing: { source: 'https://example.com/acme-video/pricing', checkedAt: CHECKED, confidence: 'ASSUMPTION' },
};

/** Clips of 5 or 10 s at $0.08/s: an 8 s shot bills 10 s, an 18 s shot two clips. */
export const ACME_CLIPS: VisualProviderCard = {
  provider: 'acme-clips',
  label: 'Acme Clips (test)',
  implemented: false,
  models: [visualModel('acme-clips', { model: 'acme-clip-2', label: 'Acme Clip 2', methods: ['GENERATIVE_VIDEO'], aspectRatios: ['16:9'], resolutions: ['1080p'], clip: clipLengths([5, 10]) })],
  rates: [rate('acme-clips', 'acme-clip-2', 'VIDEO_SECONDS', 0.08, 'list price per second of 5 or 10 s clips')],
  pricing: { source: 'https://example.com/acme-clips/pricing', checkedAt: CHECKED, confidence: 'LIST_PRICE' },
};

/** Stills at $0.04 an image. */
export const ACME_STILLS: VisualProviderCard = {
  provider: 'acme-stills',
  label: 'Acme Stills (test)',
  implemented: false,
  models: [visualModel('acme-stills', { model: 'acme-still-3', label: 'Acme Still 3', methods: ['GENERATIVE_IMAGE', 'STILL_MOTION'], aspectRatios: ALL_FRAMES, resolutions: RESOLUTIONS, clip: null })],
  rates: [rate('acme-stills', 'acme-still-3', 'IMAGES', 0.04, 'list price per image')],
  pricing: { source: 'https://example.com/acme-stills/pricing', checkedAt: CHECKED, confidence: 'LIST_PRICE' },
};

/** A catalog of cards, looked up the way the real one is (catalog order). */
export function catalogOf(cards: readonly VisualProviderCard[], version = 'test-catalog.1'): VisualCatalog {
  return {
    version,
    cards,
    forMethod: (method: ProductionMethod) => cards.flatMap((card) => card.models.filter((model) => model.methods.includes(method)).map((model) => ({ card, model }))),
  };
}

/** The made-up vendors with the in-house, archival and stock cards; the mock card last when asked. */
export function acmeCatalog(o: { mock?: boolean; version?: string } = {}): VisualCatalog {
  return catalogOf([ACME_VIDEO, ACME_CLIPS, ACME_STILLS, IN_HOUSE_CARD, ARCHIVAL_CARD, STOCK_CARD, ...(o.mock ? [MOCK_VISUAL_CARD] : [])], o.version);
}

// ── Profiles ─────────────────────────────────────────────────────────────────

/** A frozen profile as a version records it: a preset (default: the library default) with these settings over it. */
export function profileSnapshot(over: Partial<VisualStyleProfileConfig> = {}, preset = DEFAULT_VISUAL_PRESET): VisualProfileSnapshot {
  const p = VISUAL_PROFILE_PRESETS.find((x) => x.key === preset)!;
  return {
    mode: 'DEFAULT',
    revision: 0,
    familyId: `family-${p.key}`,
    familyName: p.name,
    profileId: `profile-${p.key}`,
    name: p.name,
    version: 1,
    overrides: {},
    effective: structuredClone({ ...p.config, ...over }),
    provenance: {},
  };
}

export interface FactsOptions extends SyntheticSpineOptions {
  profile?: VisualProfileSnapshot;
  catalog?: VisualCatalog;
  scopeKind?: StoryboardScope;
  approval?: NarrationApproval;
  /** The narration as given (default: synthesised from the script). */
  narration?: NarrationSpine;
}

/** Everything a storyboard of this script is planned against. */
export function syntheticFacts(scope: ScriptScope, script: ScriptDraft, o: FactsOptions = {}): StoryboardFacts {
  const keyed = withRowIds(script);
  const narration = o.narration ?? syntheticSpine(keyed, o);
  return {
    projectId: 'project-1',
    script: keyed,
    scope,
    spine: buildSpine(narration, keyed),
    profile: o.profile ?? profileSnapshot(),
    catalog: o.catalog ?? acmeCatalog(),
    scopeKind: o.scopeKind ?? (o.blocks ? 'PARTIAL' : 'FULL'),
    narrationApproval: o.approval ?? 'TAKES_APPROVED',
  };
}

// ── Drafts in a few lines ────────────────────────────────────────────────────

export interface ShotSketch extends Partial<Omit<DraftShot, 'key' | 'beatKey' | 'narration' | 'spec'>> {
  /** Where its words end (default: the end of its beat). */
  to?: string;
  /** A silence-only shot at this cut point. */
  silenceAt?: string;
  spec?: Partial<ShotContent>;
}

export interface BeatSketch {
  /** Where its words end. */
  to: string;
  /** The planned option's treatment, and its shots' unless they say (default ENVIRONMENT). */
  treatment?: VisualTreatment;
  options?: Partial<VisualBeatContent['options']>;
  title?: string;
  claimKeys?: string[];
  archBeatIds?: string[];
  subjectKeys?: string[];
  /** Default: one shot over the whole beat. */
  shots?: ShotSketch[];
}

/** A beat's content for a test. */
export function beatContent(treatment: VisualTreatment, o: Partial<DraftBeat['content']> = {}): DraftBeat['content'] {
  const option = { treatment, concept: 'A concept (test).' };
  return {
    title: 'A beat (test)',
    purpose: 'Moves the story on (test).',
    concept: 'A concept (test).',
    informationCommunicated: [],
    narrativePurpose: 'Orients the viewer (test).',
    evidenceRelationship: 'NONE',
    importance: 'NORMAL',
    complexity: 'LOW',
    continuity: { subjectKeys: [], notes: [] },
    options: { A: option, B: option, C: option },
    ...o,
  };
}

/** A draft of beats and shots over the narration, chained from the start of the scope (beats VB01…, shots SH001… in order). */
export function sketchDraft(facts: StoryboardFacts, beats: readonly BeatSketch[], o: { subjects?: DraftSubject[]; approach?: VisualApproach } = {}): StoryboardDraft {
  const approach = o.approach ?? 'C';
  let from: string = SCOPE_START;
  let n = 0;
  const out: StoryboardDraft = { approach, beats: [], shots: [], subjects: o.subjects ?? [], normalization: [] };
  beats.forEach((b, i) => {
    const key = beatKey(i + 1);
    const treatment = b.treatment ?? 'ENVIRONMENT';
    const content = beatContent(treatment, { title: b.title ?? `Beat ${i + 1} (test)`, continuity: { subjectKeys: b.subjectKeys ?? [], notes: [] } });
    content.options = { ...content.options, ...b.options, [approach]: { treatment, concept: 'A concept (test).' } };
    out.beats.push({ key, narration: { from, to: b.to }, content, archBeatIds: b.archBeatIds ?? [], claimKeys: b.claimKeys ?? [] });
    let at = from;
    for (const s of b.shots ?? [{}]) {
      n++;
      const { to, silenceAt, spec, ...rest } = s;
      const shot: DraftShot = {
        key: shotKey(n),
        beatKey: key,
        narration: silenceAt ? null : { from: at, to: to ?? b.to },
        silenceAt: silenceAt ?? null,
        visualFrom: null,
        visualTo: null,
        cutIn: 'BEAT_CHANGE',
        cutOut: 'BEAT_CHANGE',
        cutOffsetMs: 0,
        treatment,
        method: null,
        proposedClass: null,
        spec: { ...emptyContent(), purpose: 'Shows the moment (test).', description: 'What is seen (test).', ...spec },
        subjects: [],
        claims: [],
        recommendation: null,
        unplanned: false,
        ...rest,
      };
      if (!silenceAt) at = to ?? b.to;
      out.shots.push(shot);
    }
    from = b.to;
  });
  return out;
}

/** A continuity subject for a test (a full spec from the few fields that matter). */
export function subject(key: string, o: Partial<ContinuitySpec> & Pick<ContinuitySpec, 'name' | 'kind'>): DraftSubject {
  return {
    key,
    spec: {
      castId: null,
      castKind: null,
      basis: 'RECONSTRUCTION',
      anonymous: false,
      description: `${o.name} (test).`,
      era: null,
      location: null,
      approximateAge: null,
      clothing: null,
      physicalDescription: null,
      visualIdentity: { palette: [], silhouette: null, props: [] },
      designDetails: [],
      rules: [],
      claimKeys: [],
      referenceAsset: { required: false, status: 'MISSING', note: '' },
      ...o,
    },
  };
}

// ── Five synthetic films (not the acceptance documentary) ────────────────────

type FilmBlock = Parameters<typeof syntheticDraft>[1][number][number];
type FilmVisual = NonNullable<FilmBlock['visual']>;
/** A block's visual note: the intent, plus what the test needs. */
const visualNote = (intent: VisualIntent, extra: Partial<FilmVisual> = {}): FilmVisual => ({ intent, mustShow: [], mustAvoid: [], priority: 'NORMAL', note: '', ...extra });

export interface DomainFilm {
  spec: SyntheticSpec;
  blocks: FilmBlock[][];
}

/**
 * Five films from different domains, each with the material its tests need:
 * history (a composite in reconstructed beats next to documented ones, a
 * myth, a recurring harbour, a documented date and a reconstructed time of
 * day); science (a disputed explanation and a figure for a chart); business
 * (money, failed tests, a filing that can be shown as a document, a real
 * founder); biography (a verified recorded quotation and a real person's
 * likeness); investigation (disputed witnesses, a probable inquiry, a real
 * captain, a route for a map).
 */
export const DOMAIN_FILMS: Readonly<Record<'history' | 'science' | 'business' | 'biography' | 'investigation', DomainFilm>> = {
  history: {
    spec: {
      question: 'Who opened the warehouses?',
      claims: [
        { key: 'H1', statement: 'A fire destroyed the harbour of Corvel in 1771.', importance: 'KEY' },
        { key: 'H2', statement: 'The harbourmaster Elias Brandt probably ordered the warehouses opened.', verdict: 'PROBABLE', importance: 'KEY' },
        { key: 'H3', statement: 'The town council rebuilt the quays within five years.' },
        { key: 'H4', statement: 'A popular story says smugglers started the fire.', verdict: 'MYTH' },
        { key: 'H5', statement: 'Dock labourers in Corvel worked the quays by night.' },
      ],
      cast: [
        { id: 'R1', name: 'Elias Brandt', kind: 'REAL_PERSON', description: 'Harbourmaster of Corvel.', claimKeys: ['H2'] },
        { id: 'F1', name: 'Mira', kind: 'FICTIONAL_COMPOSITE', description: 'A dock worker standing for the harbour labourers.', claimKeys: ['H5'] },
      ],
      sequences: [
        {
          title: 'The night',
          setting: { location: { value: 'Corvel harbour', basis: 'DOCUMENTED' }, date: { value: '1771', basis: 'DOCUMENTED' }, timeOfDay: { value: 'night', basis: 'RECONSTRUCTION' } },
          visual: { environment: 'The harbour at night.', mustAvoid: ['modern clothing'] },
          beats: [
            { id: '1.1', basis: 'DOCUMENTED', function: 'COLD_OPEN', claimKeys: ['H1'] },
            { id: '1.2', basis: 'RECONSTRUCTION', function: 'ESCALATION', claimKeys: ['H5'], castIds: ['F1'] },
          ],
        },
        { title: 'The order', beats: [{ id: '2.1', basis: 'UNCERTAIN', function: 'REVEAL', claimKeys: ['H2'], castIds: ['R1'] }, { id: '2.2', basis: 'UNCERTAIN', function: 'INVESTIGATION', claimKeys: ['H4'] }] },
        { title: 'The rebuilding', beats: [{ id: '3.1', basis: 'DOCUMENTED', function: 'CONSEQUENCE', claimKeys: ['H3'] }] },
      ],
    },
    blocks: [
      [
        { text: 'Who opened the warehouses?', infoClass: 'FRAMING', extra: { centralQuestion: 'POSED' } },
        {
          text: 'In 1771, a fire destroyed the harbour of Corvel. The flames spread along the quays.',
          infoClass: 'DOCUMENTED',
          beatIds: ['1.1'],
          claimKeys: ['H1'],
          visual: visualNote('CINEMATIC_RECONSTRUCTION', { mustShow: [{ detail: 'the burning warehouses', claimKeys: ['H1'] }], priority: 'HIGH' }),
        },
        { text: 'Mira, a dock worker we imagine for this story, runs along the quay with a bucket. Smoke fills the warehouses.', infoClass: 'RECONSTRUCTION', beatIds: ['1.2'], claimKeys: ['H5'], visual: visualNote('CINEMATIC_RECONSTRUCTION', { note: 'Label her on screen as an invented composite.' }) },
      ],
      [
        { text: 'Records suggest the harbourmaster, Elias Brandt, ordered the warehouses opened.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['H2'] },
        { text: 'A popular story blames smugglers for the fire. The archives do not support it.', infoClass: 'UNCERTAIN', beatIds: ['2.2'], claimKeys: ['H4'] },
      ],
      [{ text: 'Within five years, the town council had rebuilt the quays.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['H3'], extra: { centralQuestion: 'ANSWERED' } }],
    ],
  },
  science: {
    spec: {
      question: 'Why did the lake turn red?',
      claims: [
        { key: 'L1', statement: 'The lake turned red in the summer of 1962.', importance: 'KEY' },
        { key: 'L2', statement: 'Scientists disagree whether algae or iron caused the colour.', verdict: 'DISPUTED', importance: 'KEY' },
        { key: 'L3', statement: 'The lake is 14 metres deep at its centre.', importance: 'BACKGROUND' },
        { key: 'L4', statement: 'Iron in the lake reached 12 milligrams per litre in 1962, after the mine upstream reopened.', claimType: 'ECONOMIC_FIGURE' },
      ],
      sequences: [
        { title: 'The colour', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'COLD_OPEN', claimKeys: ['L1'] }, { id: '1.2', basis: 'DOCUMENTED', claimKeys: ['L3'] }] },
        { title: 'The explanations', beats: [{ id: '2.1', basis: 'UNCERTAIN', function: 'INVESTIGATION', claimKeys: ['L2'] }, { id: '2.2', basis: 'DOCUMENTED', function: 'REVEAL', claimKeys: ['L4'] }] },
      ],
    },
    blocks: [
      [
        { text: 'In the summer of 1962, the lake turned red.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['L1'], extra: { centralQuestion: 'POSED' } },
        { text: 'At its centre, the lake is 14 metres deep.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['L3'] },
      ],
      [
        { text: 'Scientists still disagree: some blame the algae, others blame the iron.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['L2'] },
        { text: 'In 1962, iron in the lake reached 12 milligrams per litre, after the mine upstream reopened.', infoClass: 'DOCUMENTED', beatIds: ['2.2'], claimKeys: ['L4'], visual: visualNote('DATA'), extra: { centralQuestion: 'ANSWERED' } },
      ],
    ],
  },
  business: {
    spec: {
      question: 'How did a company without a working product raise so much money?',
      claims: [
        { key: 'B1', statement: 'Lumeo raised 40 million dollars in 2019 from three investors.', importance: 'KEY', claimType: 'ECONOMIC_FIGURE' },
        { key: 'B2', statement: 'Lumeo devices failed independent laboratory tests in 2020.', importance: 'KEY' },
        { key: 'B3', statement: 'Lumeo filed for bankruptcy in 2021.', importance: 'KEY' },
        { key: 'B4', statement: 'Dana Reyes demonstrated a glowing Lumeo device to investors in 2019.' },
      ],
      cast: [{ id: 'R1', name: 'Dana Reyes', kind: 'REAL_PERSON', description: 'Founder and chief executive of Lumeo.', claimKeys: ['B1', 'B4'] }],
      sequences: [
        { title: 'The pitch', beats: [{ id: '1.1', basis: 'DOCUMENTED', claimKeys: ['B1'] }, { id: '1.2', basis: 'RECONSTRUCTION', claimKeys: ['B4'], castIds: ['R1'] }] },
        { title: 'The tests', beats: [{ id: '2.1', basis: 'DOCUMENTED', claimKeys: ['B2'] }] },
        { title: 'The fall', beats: [{ id: '3.1', basis: 'DOCUMENTED', function: 'CONSEQUENCE', claimKeys: ['B3'] }] },
      ],
    },
    blocks: [
      [
        { text: 'In 2019, Lumeo raised 40 million dollars from three investors.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['B1'], visual: visualNote('DATA'), extra: { centralQuestion: 'POSED' } },
        { text: 'Its founder, Dana Reyes, showed them a device that glowed on the table.', infoClass: 'RECONSTRUCTION', beatIds: ['1.2'], claimKeys: ['B4'], visual: visualNote('CINEMATIC_RECONSTRUCTION') },
      ],
      [{ text: 'A year later, independent laboratories tested the devices. They failed.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['B2'] }],
      [{ text: 'In 2021, Lumeo filed for bankruptcy.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['B3'], visual: visualNote('DOCUMENT'), extra: { centralQuestion: 'ANSWERED' } }],
    ],
  },
  biography: {
    spec: {
      question: 'Why did she leave the observatory?',
      claims: [
        { key: 'Q1', statement: 'Mara Lind left the observatory in 1889.', importance: 'KEY' },
        { key: 'Q2', statement: 'Mara Lind wrote that the work had become a cage.', quote: 'The work had become a cage.', importance: 'KEY', claimType: 'QUOTE' },
        { key: 'Q3', statement: 'The observatory stood on a hill above the town.', importance: 'BACKGROUND' },
      ],
      cast: [{ id: 'R1', name: 'Mara Lind', kind: 'REAL_PERSON', description: 'Astronomer who left the observatory.', claimKeys: ['Q1', 'Q2'] }],
      sequences: [{ title: 'The letter', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'TURN', claimKeys: ['Q1', 'Q3'], castIds: ['R1'] }, { id: '1.2', basis: 'DOCUMENTED', claimKeys: ['Q2'], castIds: ['R1'] }] }],
    },
    blocks: [
      [
        { text: 'Why did she leave?', infoClass: 'FRAMING', extra: { centralQuestion: 'POSED' } },
        { text: 'In 1889, the astronomer Mara Lind left the observatory on the hill.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['Q1', 'Q3'], visual: visualNote('PORTRAIT') },
        { text: '"The work had become a cage."', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['Q2'], speakerId: 'R1', speechKind: 'RECORDED_QUOTE', visual: visualNote('ON_SCREEN_TEXT'), extra: { centralQuestion: 'ANSWERED' } },
      ],
    ],
  },
  investigation: {
    spec: {
      question: 'Who sank the ferry?',
      claims: [
        { key: 'I1', statement: 'The ferry Aster sank in the harbour on 3 March 1912.', importance: 'KEY' },
        { key: 'I2', statement: 'Witnesses disagreed about whether the captain was on the bridge.', verdict: 'DISPUTED', importance: 'KEY' },
        { key: 'I3', statement: 'An inquiry found the hull was probably weakened by an earlier collision.', verdict: 'PROBABLE', importance: 'KEY' },
        { key: 'I4', statement: 'Captain Lena Ostrom testified at the inquiry in 1913.' },
        { key: 'I5', statement: 'The Aster sailed between Nordhavn and the island of Vell.' },
      ],
      cast: [{ id: 'R1', name: 'Lena Ostrom', kind: 'REAL_PERSON', description: 'Captain of the ferry.', claimKeys: ['I4'] }],
      sequences: [
        { title: 'The sinking', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'COLD_OPEN', claimKeys: ['I1'] }, { id: '1.2', basis: 'DOCUMENTED', claimKeys: ['I5'] }] },
        { title: 'The witnesses', beats: [{ id: '2.1', basis: 'UNCERTAIN', function: 'CONFLICT', claimKeys: ['I2'] }] },
        { title: 'The inquiry', beats: [{ id: '3.1', basis: 'UNCERTAIN', function: 'REVEAL', claimKeys: ['I3'] }, { id: '3.2', basis: 'DOCUMENTED', function: 'CONSEQUENCE', claimKeys: ['I4'], castIds: ['R1'] }] },
      ],
    },
    blocks: [
      [
        { text: 'On 3 March 1912, the ferry Aster sank in the harbour.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['I1'], extra: { centralQuestion: 'POSED' } },
        { text: 'She sailed between Nordhavn and the island of Vell.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['I5'], visual: visualNote('MAP') },
      ],
      [{ text: 'Witnesses disagree about whether the captain was on the bridge.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['I2'] }],
      [
        { text: 'An inquiry found the hull was probably weakened by an earlier collision.', infoClass: 'UNCERTAIN', beatIds: ['3.1'], claimKeys: ['I3'], visual: visualNote('DOCUMENT'), extra: { centralQuestion: 'ANSWERED' } },
        { text: 'Captain Lena Ostrom testified at the inquiry in 1913.', infoClass: 'DOCUMENTED', beatIds: ['3.2'], claimKeys: ['I4'] },
      ],
    ],
  },
};

export type DomainName = keyof typeof DOMAIN_FILMS;

/** A film's scope, script (with row ids) and the facts a storyboard of it is planned against. */
export function domainFilm(name: DomainName, o: FactsOptions = {}): { scope: ScriptScope; script: ScriptDraft; facts: StoryboardFacts } {
  const film = DOMAIN_FILMS[name];
  const scope = syntheticScope(film.spec);
  const script = withRowIds(syntheticDraft(scope, film.blocks));
  return { scope, script, facts: syntheticFacts(scope, script, o) };
}

// ── A scripted AI for the planning calls ─────────────────────────────────────

/** Cut point ids in a prompt, in order of first appearance. */
export const cutPointsIn = (prompt: string) => [...new Set([...prompt.matchAll(/⟨start⟩|⟨end⟩|\b\d+\.\d+:(?:0|[1-9]\d*|end)\b/g)].map((m) => m[0]))];

const option = (treatment: VisualTreatment) => ({ treatment, concept: 'A concept (test).' });

/** One beat per block, from the first cut point in the prompt to each block's end: every class allows these options. */
export function fakeBeats(prompt: string): BeatsOutput {
  const ids = cutPointsIn(prompt);
  const ends = ids.filter((id) => id.endsWith(':end') || id === SCOPE_END);
  let from = ids[0] ?? SCOPE_START;
  const beats: BeatsOutput['beats'] = [];
  for (const to of ends) {
    if (to === from) continue;
    beats.push({
      from,
      to,
      title: `Up to ${to} (test)`,
      purpose: 'Shows the place (test).',
      concept: 'The place where it happens (test).',
      informationCommunicated: [],
      narrativePurpose: 'Orients the viewer (test).',
      evidenceRelationship: 'NONE',
      importance: 'NORMAL',
      complexity: 'LOW',
      archBeatIds: [],
      claimKeys: [],
      subjectKeys: [],
      continuityNotes: [],
      options: { A: option('ENVIRONMENT'), B: option('MOTION_GRAPHIC'), C: option('ENVIRONMENT') },
    });
    from = to;
  }
  return { beats, subjects: [] };
}

/** A shot of a test: an environment with no people and no claims (the fields a test does not set). */
export function fakeShot(beatKey: string, narration: { from: string; to: string } | null, o: Partial<ShotOutput> = {}): ShotOutput {
  return {
    beatKey,
    narration,
    silenceAt: null,
    visualFrom: null,
    visualTo: null,
    cutIn: 'BEAT_CHANGE',
    cutOut: 'BEAT_CHANGE',
    treatment: 'ENVIRONMENT',
    method: null,
    infoClass: null,
    purpose: 'Shows the place (test).',
    description: 'An empty quay at dusk (test).',
    composition: 'Wide, low horizon (test).',
    shotType: 'WIDE',
    camera: { angle: 'eye level', lens: null },
    movement: { motion: 'PUSH_IN', intensity: 'LOW', note: '' },
    environment: { subjectKey: null, description: 'A quay (test).' },
    objects: [],
    lighting: 'Dusk (test).',
    mood: 'Quiet (test).',
    transitionIn: 'CUT',
    transitionOut: 'CUT',
    continuityNotes: [],
    mustShow: [],
    mustAvoid: [],
    specifics: [],
    overlays: [],
    uncertaintyDevice: 'NONE',
    dataSpec: null,
    style: { realism: null, filmGrain: null, motionIntensity: null, lighting: null },
    subjects: [],
    claims: [],
    notes: [],
    ...o,
  };
}

/**
 * A scripted AI for the storyboard's planning calls (and, through
 * FakeScriptAI, the stages before it). By default it proposes one beat per
 * block from the cut points in the prompt and, for the beats named in a
 * shots prompt that it proposed itself, one environment shot each — a plan
 * with no blocking finding. Tests replace any answer (to plan specific shots
 * or inject defects); nothing is sent anywhere.
 */
export class FakeStoryboardAI extends FakeScriptAI {
  /** The beats call's answer. */
  beats: (prompt: string) => BeatsOutput = fakeBeats;
  /** The shots call's answer (default: one shot per beat it proposed, over the beat). */
  shots: (prompt: string) => ShotsOutput = (prompt) => this.defaultShots(prompt);
  /** The repair call's answer (default: no replacement). */
  repair: (prompt: string) => RepairOutput = () => ({ beats: [] });
  /** System prompts of the storyboard calls, by task. */
  storyboardSystems: Record<string, string[]> = {};
  /** Beat ranges it proposed, by the key code gives them (VB01… in clock order). */
  private proposed = new Map<string, { from: string; to: string }>();

  private defaultShots(prompt: string): ShotsOutput {
    const keys = [...new Set([...prompt.matchAll(/\bVB\d{2,4}\b/g)].map((m) => m[0]))].filter((k) => this.proposed.has(k));
    if (!keys.length) throw new Error('FakeStoryboardAI: no beat it proposed is named in the shots prompt; give it a scripted answer');
    return { shots: keys.map((k) => fakeShot(k, this.proposed.get(k)!)), beats: [] };
  }

  override async generateObject<T>(req: ObjectGenerationRequest<T>): Promise<ObjectGenerationResult<T>> {
    if (!req.task.startsWith('storyboard.')) return super.generateObject(req);
    this.calls[req.task] = (this.calls[req.task] ?? 0) + 1;
    const user = req.messages.map((m) => m.content).join('\n');
    (this.prompts[req.task] ??= []).push(user);
    (this.storyboardSystems[req.task] ??= []).push(req.system ?? '');
    if (this.failNextTask === req.task) {
      this.failNextTask = null;
      throw new ProviderError('fake-ai', 'overloaded (test)', true);
    }
    if (this.brokenTask === req.task) throw new ProviderError('fake-ai', 'refused (test)', false);
    let object: unknown;
    if (req.task.startsWith('storyboard.beats')) {
      const out = this.beats(user);
      this.proposed = new Map(out.beats.map((b, i) => [beatKey(i + 1), { from: b.from, to: b.to }]));
      object = out;
    } else if (req.task.startsWith('storyboard.shots')) object = this.shots(user);
    else if (req.task.startsWith('storyboard.repair')) object = this.repair(user);
    else throw new Error(`FakeStoryboardAI: unknown task ${req.task}`);
    return {
      object: req.schema.parse(object),
      meta: { provider: 'fake-ai', model: 'fake-model', mock: false, usage: [{ unit: 'INPUT_TOKENS', quantity: Math.round(user.length / 4) }, { unit: 'OUTPUT_TOKENS', quantity: 3_000 }] },
    };
  }
}
