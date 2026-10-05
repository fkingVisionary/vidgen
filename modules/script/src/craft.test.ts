import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptTiming, type RuntimeTarget } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { craftFindings, dependentsOf, detectRefrains, protectedBlocks, selfReportMismatch, trimPlan } from './craft.ts';
import { allBlocks, type ScriptDraft } from './draft.ts';
import { checkScript, cutPlan, type ScriptFinding } from './rules.ts';
import type { ScriptScope } from './scope.ts';
import { syntheticDraft, syntheticScope } from './testing.ts';

/**
 * The script quality rules on synthetic films from five domains — business,
 * science, military, biography and history. None of them is the acceptance
 * documentary: the rules must hold for any subject.
 */

const ONE_MINUTE: RuntimeTarget = { minSec: 40, maxSec: 400, targetSec: 200 };
const craft = (scope: ScriptScope, draft: ScriptDraft, target = ONE_MINUTE, previous?: ScriptDraft) => craftFindings(draft, scope, scriptTiming(allBlocks(draft), target), { previous });
const of = (fs: readonly ScriptFinding[], kind: ScriptFinding['kind']) => fs.filter((f) => f.kind === kind);
const refs = (fs: readonly ScriptFinding[], kind: ScriptFinding['kind']) => of(fs, kind).map((f) => f.ref);

// ── Business: a start-up's rise and fall ─────────────────────────────────────

const business = syntheticScope({
  question: 'How did a company without a working product raise so much money?',
  claims: [
    { key: 'B1', statement: 'Lumeo raised 40 million dollars in 2019 from three investors.', importance: 'KEY' },
    { key: 'B2', statement: 'Lumeo devices failed independent laboratory tests in 2020.', importance: 'KEY' },
    { key: 'B3', statement: 'Lumeo filed for bankruptcy in 2021.', importance: 'KEY' },
  ],
  cast: [{ id: 'R1', name: 'Dana Reyes', kind: 'REAL_PERSON', description: 'Founder and chief executive of Lumeo.', claimKeys: ['B1'] }],
  sequences: [
    { title: 'The pitch', beats: [{ id: '1.1', basis: 'DOCUMENTED', claimKeys: ['B1'], castIds: ['R1'] }] },
    { title: 'The tests', beats: [{ id: '2.1', basis: 'DOCUMENTED', claimKeys: ['B2'] }] },
    { title: 'The fall', beats: [{ id: '3.1', basis: 'DOCUMENTED', function: 'CONSEQUENCE', claimKeys: ['B3'] }, { id: '3.2', basis: 'DOCUMENTED', claimKeys: ['B1', 'B2'] }] },
  ],
});

const businessDraft = () =>
  syntheticDraft(business, [
    [
      { text: 'How did a company without a working product raise so much money?', infoClass: 'FRAMING', extra: { centralQuestion: 'POSED' } },
      { text: 'Dana Reyes, the founder of Lumeo, raised 40 million dollars in 2019 from three investors who never saw a device work outside her office.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['B1'] },
      { text: 'The money was real.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['B1'] },
    ],
    [
      { text: 'In 2020 independent laboratories finally tested the devices. They failed.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['B2'] },
      { text: 'The money was real.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['B2'] },
    ],
    [
      { text: 'In 2021 Lumeo filed for bankruptcy.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['B3'] },
      { text: 'To recap: Dana Reyes had raised 40 million dollars in 2019 from three investors who never saw a device work outside her office.', infoClass: 'DOCUMENTED', beatIds: ['3.2'], claimKeys: ['B1'] },
      { text: 'And in 2020 independent laboratories had tested the devices, which failed every one of the tests.', infoClass: 'DOCUMENTED', beatIds: ['3.2'], claimKeys: ['B2'] },
      { text: 'The money was real.', infoClass: 'DOCUMENTED', beatIds: ['3.2'], claimKeys: ['B1'], extra: { centralQuestion: 'ANSWERED' } },
    ],
  ]);

describe('redundancy and deliberate repetition (business)', () => {
  it('flags blocks and a section that retell what the viewer has heard', () => {
    const fs = craft(business, businessDraft()).findings;
    expect(refs(fs, 'RETOLD_CONTENT')).toEqual(['3.2', '3.3']);
    expect(of(fs, 'RETOLD_CONTENT')[0]!.detail).toMatch(/^Block 3\.2 retells 1\.2 \(\d+% of its words, the same B1\): the viewer has heard it/);
    expect(refs(fs, 'RECAP_SECTION')).toEqual(['S3']);
  });

  it('recognises a refrain and leaves it alone — it is not redundancy, not a repeated phrase, and must survive a refinement', () => {
    const draft = businessDraft();
    expect(detectRefrains(draft, business)).toEqual(expect.arrayContaining([{ phrase: 'the money was real', refs: ['1.3', '2.2', '3.4'], kind: 'REFRAIN', purpose: 'CLOSURE' }]));
    const all = checkScript(draft, business, { target: ONE_MINUTE });
    expect(refs(all, 'RETOLD_CONTENT')).not.toContain('2.2');
    expect(refs(all, 'RETOLD_CONTENT')).not.toContain('3.4');
    expect(of(all, 'REPEATED_PHRASES')).toEqual([]);
    // A refinement that keeps it twice keeps the device; one that cuts it to a single telling, or drops it, is told so.
    const thinned = businessDraft();
    thinned.sections[1]!.blocks.pop();
    expect(of(craft(business, thinned, ONE_MINUTE, draft).findings, 'REFRAIN_LOST')).toEqual([]);
    // Reworded around its core, it still repeats.
    const extended = businessDraft();
    extended.sections[2]!.blocks.at(-1)!.text = 'The money was real, and so were the losses.';
    expect(of(craft(business, extended, ONE_MINUTE, draft).findings, 'REFRAIN_LOST')).toEqual([]);
    thinned.sections[2]!.blocks.pop();
    expect(of(craft(business, thinned, ONE_MINUTE, draft).findings, 'REFRAIN_LOST').map((f) => f.detail)).toEqual([
      'The refrain "the money was real" (1.3, 2.2, 3.4 in the previous version) is said only once now (1.3): repetition that pays off is not redundancy',
    ]);
    thinned.sections[0]!.blocks.pop();
    expect(of(craft(business, thinned, ONE_MINUTE, draft).findings, 'REFRAIN_LOST').map((f) => f.detail)).toEqual([
      'The refrain "the money was real" (1.3, 2.2, 3.4 in the previous version) is gone: repetition that pays off is not redundancy',
    ]);
  });
});

// ── Science: a comet's return ────────────────────────────────────────────────

const science = syntheticScope({
  question: 'Was the comet’s return a lucky guess?',
  claims: [
    { key: 'S1', statement: 'Ines Marlow predicted in 1902 that the comet would return within twelve years.', importance: 'KEY' },
    { key: 'S2', statement: 'The comet returned in 1913, within weeks of the predicted date.', importance: 'KEY' },
    { key: 'S3', statement: 'The observatory telescope had a lens of 60 centimetres.', importance: 'BACKGROUND' },
    { key: 'S4', statement: 'An encyclopedia entry of 1931 repeated the prediction.', importance: 'BACKGROUND' },
  ],
  cast: [{ id: 'R1', name: 'Ines Marlow', kind: 'REAL_PERSON', description: 'Astronomer who predicted the comet would return.', claimKeys: ['S1'] }],
  sequences: [
    { title: 'The prediction', beats: [{ id: '1.1', basis: 'DOCUMENTED', claimKeys: ['S1'], castIds: ['R1'] }, { id: '1.2', basis: 'DOCUMENTED', claimKeys: ['S3'] }] },
    { title: 'The return', beats: [{ id: '2.1', basis: 'DOCUMENTED', function: 'REVEAL', claimKeys: ['S2'] }, { id: '2.2', basis: 'DOCUMENTED', claimKeys: ['S4'] }] },
  ],
});

describe('low-value exposition (science)', () => {
  const draft = () =>
    syntheticDraft(science, [
      [
        { text: 'Ines Marlow, an astronomer at a small observatory, predicted in 1902 that the comet would come back within twelve years.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['S1'] },
        { text: 'The observatory telescope, built by Hartwell, had a lens of 60 centimetres.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['S3'] },
      ],
      [
        { text: 'In 1913 the comet came back, within weeks of her date.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['S2'] },
        { text: 'The Pellman encyclopedia of 1931 notes that the prediction was repeated.', infoClass: 'DOCUMENTED', beatIds: ['2.2'], claimKeys: ['S4'] },
      ],
    ]);

  it('flags facts along for the ride, and leaves the story’s facts alone', () => {
    const fs = craft(science, draft()).findings;
    expect(refs(fs, 'PASSENGER_FACT')).toEqual(['1.2', '2.2']);
    expect(of(fs, 'PASSENGER_FACT')[1]!.detail).toBe(
      'Block 2.2 may be a passenger: nobody in it, no story beat, not a key claim or the question, no cause and effect, no open question, and no later section builds on it; it rests only on background claims; it names Pellman and never again; it cites Pellman for its own sake — would the viewer miss it? A candidate, not a deletion: cut it, or tie it to the people and the question',
    );
  });

  it('flags authorities named once only to be cited, and blocks that load several new names', () => {
    const chatty = syntheticDraft(science, [
      [
        { text: 'According to Okafor, Ines Marlow, an astronomer, predicted in 1902 that the comet would return within twelve years.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['S1'] },
        { text: 'Lindqvist argues the telescope, with its lens of 60 centimetres, was enough.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['S3'] },
      ],
      [
        { text: 'In 1913 the comet came back, as Halvorsen notes, within weeks of her date.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['S2'] },
        { text: 'An encyclopedia entry of 1931 by Varga, Holst and Mbeki repeated the prediction.', infoClass: 'DOCUMENTED', beatIds: ['2.2'], claimKeys: ['S4'] },
      ],
    ]);
    const fs = craft(science, chatty).findings;
    expect(of(fs, 'SOURCE_CHATTER').map((f) => f.detail)).toEqual(['The narration cites 3 authorities it names only once (Okafor, Lindqvist, Halvorsen): name a source when it becomes part of the story, not to footnote it']);
    expect(refs(fs, 'NAME_LOAD')).toEqual(['2.2']);
  });
});

// ── Military: a siege that runs long at the end ──────────────────────────────

const military = syntheticScope({
  question: 'Why did the fort hold?',
  claims: [
    { key: 'K1', statement: 'The garrison held Fort Kessel for 41 days.', importance: 'KEY' },
    { key: 'K2', statement: 'A relief column reached the fort on the 42nd day.', importance: 'KEY' },
    { key: 'K3', statement: 'The walls of the fort were rebuilt in 1850.', importance: 'BACKGROUND' },
    { key: 'K4', statement: 'Colonel Arden, the commander, refused two offers of surrender.', importance: 'SUPPORTING' },
  ],
  cast: [{ id: 'R1', name: 'Colonel Arden', kind: 'REAL_PERSON', description: 'Commander of the garrison.', claimKeys: ['K4'] }],
  sequences: [
    { title: 'The fort', seconds: 12, beats: [{ id: '1.1', basis: 'DOCUMENTED', claimKeys: ['K1'] }] },
    { title: 'The siege', seconds: 12, beats: [{ id: '2.1', basis: 'DOCUMENTED', function: 'CONFLICT', claimKeys: ['K4'], castIds: ['R1'] }] },
    { title: 'The relief', seconds: 12, beats: [{ id: '3.1', basis: 'DOCUMENTED', function: 'TURN', claimKeys: ['K2'] }, { id: '3.2', basis: 'DOCUMENTED', claimKeys: ['K1', 'K3', 'K4'] }] },
  ],
});
// Planned at 36 seconds, with 40 the most it may run: the relief section runs far longer than its share.
const siegeTarget: RuntimeTarget = { minSec: 30, maxSec: 40, targetSec: 36 };

const siege = () =>
  syntheticDraft(military, [
    [
      { text: 'Why did the fort hold?', infoClass: 'FRAMING', extra: { centralQuestion: 'POSED' } },
      { text: 'For 41 days the garrison held Fort Kessel against an army ten times its size.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['K1'] },
    ],
    [{ text: 'Its commander, Colonel Arden, refused two offers of surrender and kept the gates shut.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['K4'] }],
    [
      { text: 'On the 42nd day a relief column reached the fort.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['K2'] },
      { text: 'For 41 days, remember, the garrison had held Fort Kessel against an army ten times its size, behind its walls.', infoClass: 'DOCUMENTED', beatIds: ['3.2'], claimKeys: ['K1'] },
      { text: 'The walls of the fort, built of grey stone, had been rebuilt by Messner in 1850, a generation before the siege began.', infoClass: 'DOCUMENTED', beatIds: ['3.2'], claimKeys: ['K3'] },
      { text: 'Colonel Arden had refused two offers of surrender and kept the gates shut, day after day, as the army waited outside.', infoClass: 'DOCUMENTED', beatIds: ['3.2'], claimKeys: ['K4'] },
      { text: 'The fort held because its commander would not open the gates.', infoClass: 'DOCUMENTED', beatIds: ['3.2'], claimKeys: ['K4'], extra: { centralQuestion: 'ANSWERED' } },
    ],
  ]);

describe('section pacing and where to cut (military)', () => {
  it('points at the section over its share and an ending that drags', () => {
    const draft = siege();
    const timing = scriptTiming(allBlocks(draft), siegeTarget);
    expect(timing.totalSec).toBeGreaterThan(siegeTarget.maxSec);
    const fs = craft(military, draft, siegeTarget).findings;
    expect(refs(fs, 'SECTION_OVER_BUDGET')).toEqual(['S3']);
    expect(refs(fs, 'ENDING_DRAG')).toEqual(['S3']);
  });

  it('ranks the retellings and the passenger first, and never offers the turn, the answer or an introduction', () => {
    const draft = siege();
    const { plan, text } = cutPlan(draft, military, { target: siegeTarget });
    expect(plan).not.toBeNull();
    expect(plan!.candidates.slice(0, 3).map((c) => c.ref).sort()).toEqual(['3.2', '3.3', '3.4']);
    expect(plan!.candidates.find((c) => c.ref === '3.3')!.reasons).toEqual(expect.arrayContaining(['a passenger fact', 'background only']));
    const protectedRefs = plan!.protected.map((p) => p.ref);
    for (const ref of ['1.1', '3.1', '3.5', '2.1']) expect(protectedRefs).toContain(ref);
    expect(plan!.candidates.map((c) => c.ref)).not.toEqual(expect.arrayContaining(['3.1', '3.5', '2.1']));
    expect(text).toMatch(/^This version runs \d:\d\d, 0:\d\d over the acceptable maximum of 0:40/);
    expect(text).toContain('Never cut: ');
    // The finding the editor sees.
    expect(of(checkScript(draft, military, { target: siegeTarget }), 'RUNTIME_PLAN')[0]!.detail).toMatch(/^Over the 0:40 maximum by 0:\d\d: cut or compress first 3\.\d/);
  });

  it('does not mistake an ending that repeats the opening for a callback', () => {
    const draft = siege();
    expect(detectRefrains(draft, military).filter((r) => r.kind === 'CALLBACK')).toEqual([]);
    expect(refs(craft(military, draft, siegeTarget).findings, 'RETOLD_CONTENT')).toEqual(['3.2', '3.4']);
    expect(refs(craft(military, draft, siegeTarget).findings, 'RECAP_SECTION')).toEqual(['S3']);
  });

  it('makes no plan when the film fits', () => {
    const draft = siege();
    const timing = scriptTiming(allBlocks(draft), { minSec: 30, maxSec: 400, targetSec: 200 });
    expect(trimPlan(draft, timing, [], protectedBlocks(draft, military, []), military)).toBeNull();
  });
});

// ── Biography: written for the ear ───────────────────────────────────────────

const biography = syntheticScope({
  question: 'How did she keep composing?',
  claims: [
    { key: 'M1', statement: 'Clara Wendt lost her hearing in 1880 and kept composing.', importance: 'KEY' },
    { key: 'M2', statement: 'Between 1881 and 1889 Clara Wendt wrote 42 works for 3 orchestras.', importance: 'SUPPORTING' },
  ],
  cast: [{ id: 'R1', name: 'Clara Wendt', kind: 'REAL_PERSON', description: 'Composer who lost her hearing.', claimKeys: ['M1'] }],
  sequences: [{ title: 'Silence', beats: [{ id: '1.1', basis: 'DOCUMENTED', claimKeys: ['M1'], castIds: ['R1'] }, { id: '1.2', basis: 'DOCUMENTED', claimKeys: ['M2'] }] }],
});

describe('spoken-language naturalness (biography)', () => {
  it('flags page syntax, lists, strings of numbers and essay prose — and leaves natural speech alone', () => {
    const draft = syntheticDraft(biography, [
      [
        { text: 'Clara Wendt, a composer, lost her hearing in 1880. Her method was simple: she wrote at night; she slept by day (and rarely ate).', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['M1'] },
        { text: 'She wrote sonatas, songs, masses, operettas, and a symphony.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['M2'] },
        { text: 'Between 1881 and 1889 she wrote 42 works for 3 orchestras.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['M2'] },
        { text: 'The consolidation of her administration and the implementation of new compositional conventions required the reorganisation of her institution.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['M1'] },
        { text: 'She could not hear the applause. She saw it. She wrote, she taught, and she listened with her hands.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['M1'] },
      ],
    ]);
    const fs = craft(biography, draft).findings;
    expect(of(fs, 'WRITTEN_SYNTAX').map((f) => f.detail)).toEqual(['Block 1.1 uses a semicolon, parentheses, a colon: page syntax — say it as separate sentences']);
    expect(refs(fs, 'LIST_SENTENCE')).toEqual(['1.2']);
    expect(refs(fs, 'NUMBER_DENSE')).toEqual(['1.3']);
    expect(refs(fs, 'NOUN_HEAVY')).toEqual(['1.4']);
    // The natural block, with its deliberate triple, has none of these.
    expect(fs.filter((f) => f.ref === '1.5')).toEqual([]);
  });

  it('does not count the day of a date as another number, and flags sentences of one length', () => {
    const dated = syntheticDraft(biography, [[{ text: 'On 3 February 1885 she finished it, alone.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['M1'] }]]);
    expect(of(craft(biography, dated).findings, 'NUMBER_DENSE')).toEqual([]);
    const flat = syntheticDraft(biography, [
      [
        { text: 'Clara Wendt, a composer, lost her hearing that year. She went on writing music every single day. She kept every page in a wooden box. She wrote the parts out again by hand.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['M1'] },
        { text: 'She sent the scores to the orchestra by post. She waited for their letters every single week. She read every letter twice at her table. She never went to hear them play.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['M1'] },
      ],
    ]);
    expect(refs(craft(biography, flat).findings, 'MONOTONOUS_RHYTHM')).toEqual(['S1']);
  });
});

// ── History: the narrator, the people and the evidence ───────────────────────

const history = syntheticScope({
  question: 'Who opened the warehouses?',
  claims: [
    { key: 'H1', statement: 'A fire destroyed the harbour of Corvel in 1771.', importance: 'KEY' },
    { key: 'H2', statement: 'The harbourmaster Elias Brandt probably ordered the warehouses opened.', verdict: 'PROBABLE', importance: 'KEY' },
    { key: 'H3', statement: 'The town council rebuilt the quays within five years.', importance: 'SUPPORTING' },
  ],
  cast: [
    { id: 'R1', name: 'Elias Brandt', kind: 'REAL_PERSON', description: 'Harbourmaster of Corvel.', claimKeys: ['H2'] },
    { id: 'F1', name: 'Mira', kind: 'FICTIONAL_COMPOSITE', description: 'A dock worker standing for the harbour labourers.' },
  ],
  sequences: [
    { title: 'The night', beats: [{ id: '1.1', basis: 'DOCUMENTED', claimKeys: ['H1'] }, { id: '1.2', basis: 'FICTION', castIds: ['F1'] }] },
    { title: 'The order', beats: [{ id: '2.1', basis: 'UNCERTAIN', claimKeys: ['H2'], castIds: ['R1'] }, { id: '2.2', basis: 'FICTION', castIds: ['F1'] }] },
    { title: 'The rebuilding', beats: [{ id: '3.1', basis: 'DOCUMENTED', claimKeys: ['H3'] }] },
  ],
});

describe('meta-narration, introductions and evidence (history)', () => {
  it('allows one framing line about the film in the opening, and flags every other', () => {
    const draft = syntheticDraft(history, [
      [{ text: 'In this film, we will find out who opened the warehouses on the night of the fire.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['H1'] }],
      [{ text: 'As we will see, the harbourmaster Elias Brandt probably gave the order himself.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['H2'] }],
      [{ text: "Let's go back to the quays. The town council rebuilt them within five years.", infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['H3'] }],
    ]);
    expect(refs(craft(history, draft).findings, 'META_NARRATION')).toEqual(['2.1', '3.1']);
  });

  it('wants a fictional device introduced once, plainly, and a real person introduced by what they do', () => {
    const labelled = syntheticDraft(history, [
      [
        { text: 'A fire swept the harbour of Corvel in 1771.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['H1'] },
        { text: 'Mira, who is invented, made up for this story, carries rope along the quay.', infoClass: 'FICTION', beatIds: ['1.2'] },
      ],
      [
        { text: 'Brandt probably ordered the warehouses opened.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['H2'] },
        { text: 'Mira, our invented dock worker, watches the smoke.', infoClass: 'FICTION', beatIds: ['2.2'] },
      ],
      [{ text: 'The town council rebuilt the quays within five years.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['H3'] }],
    ]);
    const fs = craft(history, labelled).findings;
    expect(refs(fs, 'DEVICE_LABEL_STACKED')).toEqual(['1.2']);
    expect(of(fs, 'DEVICE_RELABELLED').map((f) => f.detail)).toEqual(['Mira is labelled as invented in 2 blocks (1.2, 2.2): say it once, at the introduction']);
    expect(of(fs, 'PERSON_UNINTRODUCED').map((f) => f.detail)).toEqual(['Elias Brandt is named in 2.1 without saying who they are: introduce people by what they do the first time']);
    expect(refs(fs, 'DEVICE_UNINTRODUCED')).toEqual([]);

    const plain = syntheticDraft(history, [
      [
        { text: 'A fire swept the harbour of Corvel in 1771.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['H1'] },
        { text: 'Mira carries rope along the quay.', infoClass: 'FICTION', beatIds: ['1.2'] },
      ],
      [
        { text: 'The harbourmaster, Elias Brandt, probably ordered the warehouses opened.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['H2'] },
        { text: 'Mira watches the smoke.', infoClass: 'FICTION', beatIds: ['2.2'] },
      ],
      [{ text: 'The town council rebuilt the quays within five years.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['H3'] }],
    ]);
    const quiet = craft(history, plain).findings;
    expect(refs(quiet, 'DEVICE_UNINTRODUCED')).toEqual(['1.2']);
    expect(of(quiet, 'PERSON_UNINTRODUCED')).toEqual([]);
    // An on-screen label is an introduction too.
    plain.sections[0]!.blocks[1]!.visual.note = 'On-screen label: an invented dock worker.';
    expect(refs(craft(history, plain).findings, 'DEVICE_UNINTRODUCED')).toEqual([]);
  });

  it('blocks a sentence about a named person that cites no claim about them, and flags a sentence that states an uncited claim', () => {
    const draft = syntheticDraft(history, [
      [{ text: 'A fire destroyed the harbour of Corvel in 1771.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['H1'] }],
      [{ text: 'The harbourmaster, Elias Brandt, probably ordered the warehouses opened.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['H2'] }],
      [
        { text: 'Elias Brandt watched the council rebuild the quays within five years.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['H3'] },
        { text: 'The town council rebuilt the quays, and the harbourmaster probably ordered the warehouses opened again.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['H3'] },
      ],
    ]);
    const all = checkScript(draft, history, { target: ONE_MINUTE });
    expect(of(all, 'PERSON_WITHOUT_EVIDENCE').map((f) => f.detail)).toEqual(['Block 3.1 names Elias Brandt but cites no claim about them (H2 is): cite it, worded as its verdict requires, or cut the name']);
    expect(refs(all, 'UNCITED_CLAIM_MATCH')).toEqual(['3.2']);
    expect(of(all, 'UNCITED_CLAIM_MATCH')[0]!.detail).toMatch(/^Block 3\.2 may state H2 \(PROBABLE\) without citing it/);
    // Cited, the person is supported (and the claim's own wording rules apply).
    draft.sections[2]!.blocks[0]!.claimKeys = ['H3', 'H2'];
    expect(of(checkScript(draft, history, { target: ONE_MINUTE }), 'PERSON_WITHOUT_EVIDENCE')).toEqual([]);
  });
});

describe('a callback (science)', () => {
  const bookended = () =>
    syntheticDraft(science, [
      [
        { text: 'Every night Ines Marlow, an astronomer, climbed the same hundred steps to the dome.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['S1'] },
        { text: 'In 1902 she predicted that the comet would come back within twelve years.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['S1'] },
      ],
      [
        { text: 'In 1913 the comet came back, within weeks of her date.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['S2'] },
        { text: 'That night she climbed the same hundred steps to the dome, and waited for it to rise.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['S2'] },
      ],
    ]);

  it('recognises a phrase that returns at the ending as a callback: protected, and not a retelling', () => {
    const draft = bookended();
    const callbacks = detectRefrains(draft, science).filter((r) => r.kind === 'CALLBACK');
    expect(callbacks).toEqual([{ phrase: 'climbed the same hundred steps to the dome', refs: ['1.1', '2.2'], kind: 'CALLBACK', purpose: 'CLOSURE' }]);
    expect(refs(craft(science, draft).findings, 'RETOLD_CONTENT')).toEqual([]);
    const protect = protectedBlocks(draft, science, callbacks);
    expect(protect.get('1.1')).toBe('a callback ("climbed the same hundred steps to the dome")');
    expect(protect.has('2.2')).toBe(true);
  });

  it('survives a refinement that rewords around it, and not one that cuts it', () => {
    const draft = bookended();
    const reworded = bookended();
    reworded.sections[1]!.blocks[1]!.text = 'That night, for the last time, she climbed the same hundred steps and waited.';
    expect(of(craft(science, reworded, ONE_MINUTE, draft).findings, 'REFRAIN_LOST')).toEqual([]);
    const cut = bookended();
    cut.sections[1]!.blocks[1]!.text = 'That night she waited for it to rise.';
    expect(of(craft(science, cut, ONE_MINUTE, draft).findings, 'REFRAIN_LOST').map((f) => f.detail)).toEqual([
      'The callback "climbed the same hundred steps to the dome" (1.1, 2.2 in the previous version) is said only once now (1.1): repetition that pays off is not redundancy',
    ]);
  });
});

// ── Callbacks, as the engine defines them (business, history, science) ───────

const collapse = syntheticScope({
  question: 'Why did it all fall apart?',
  claims: [
    { key: 'V1', statement: 'Vantor grew to four thousand employees by 2015.', importance: 'KEY' },
    { key: 'V2', statement: 'Historians disagree about what caused the collapse.', verdict: 'DISPUTED', importance: 'KEY' },
    { key: 'V3', statement: 'Dr. Ruth Smith studied the company accounts.', importance: 'SUPPORTING' },
    { key: 'V4', statement: 'Vantor collapsed in 2019.', importance: 'KEY' },
  ],
  cast: [{ id: 'R1', name: 'Ruth Smith', kind: 'REAL_PERSON', description: 'Economist who studied the accounts.', claimKeys: ['V3'] }],
  sequences: [
    { title: 'The rise', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'COLD_OPEN', claimKeys: ['V1'] }, { id: '1.2', basis: 'UNCERTAIN', function: 'CONFLICT', claimKeys: ['V2'] }] },
    { title: 'The accounts', beats: [{ id: '2.1', basis: 'DOCUMENTED', function: 'INVESTIGATION', claimKeys: ['V3'], castIds: ['R1'] }] },
    { title: 'The fall', beats: [{ id: '3.1', basis: 'DOCUMENTED', function: 'INVESTIGATION', claimKeys: ['V3'], castIds: ['R1'] }, { id: '3.2', basis: 'UNCERTAIN', function: 'CONFLICT', claimKeys: ['V2'] }, { id: '3.3', basis: 'DOCUMENTED', function: 'CONSEQUENCE', claimKeys: ['V4'] }] },
  ],
});

describe('callbacks, as the engine defines them', () => {
  const film = () =>
    syntheticDraft(collapse, [
      [
        { text: 'Why did it all fall apart?', infoClass: 'FRAMING', extra: { centralQuestion: 'POSED' } },
        { text: 'The company appears unstoppable.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['V1'] },
        { text: 'Historians disagree about exactly what happened.', infoClass: 'UNCERTAIN', beatIds: ['1.2'], claimKeys: ['V2'] },
      ],
      [{ text: 'Dr. Smith explains the discovery.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['V3'] }],
      [
        { text: 'Dr. Smith explains the later experiment.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['V3'] },
        { text: 'Historians disagree about the details.', infoClass: 'UNCERTAIN', beatIds: ['3.2'], claimKeys: ['V2'] },
        { text: 'The same numbers that once made the company look invincible now expose why it collapsed.', infoClass: 'DOCUMENTED', beatIds: ['3.3'], claimKeys: ['V4'], extra: { centralQuestion: 'ANSWERED' } },
      ],
    ]);

  it('counts a later passage that recalls an earlier idea to reverse it — not a repeated hedge, not a recurring person', () => {
    const found = detectRefrains(film(), collapse).filter((r) => r.kind !== 'ESCALATION');
    expect(found).toEqual([{ phrase: 'company', refs: ['1.2', '3.3'], kind: 'CALLBACK', purpose: 'REVERSAL', recall: true }]);
    // The reversal is protected from cuts; the hedge and the person are not.
    const protect = protectedBlocks(film(), collapse, found);
    expect(protect.get('1.2')).toBe('a callback ("company")');
    expect(protect.has('3.2')).toBe(false);
  });

  it('does not take a recurring term for a callback', () => {
    const ledger = syntheticDraft(collapse, [
      [
        { text: 'Why did it all fall apart?', infoClass: 'FRAMING', extra: { centralQuestion: 'POSED' } },
        { text: 'The quarterly ledger records every sale.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['V1'] },
      ],
      [{ text: 'The quarterly ledger records the first loss.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['V3'] }],
      [{ text: 'In 2019 the quarterly ledger records nothing at all.', infoClass: 'DOCUMENTED', beatIds: ['3.3'], claimKeys: ['V4'], extra: { centralQuestion: 'ANSWERED' } }],
    ]);
    expect(detectRefrains(ledger, collapse).filter((r) => r.kind === 'CALLBACK')).toEqual([]);
  });

  it('keeps a purposeful return out of the retellings, and still flags a return that only says it again', () => {
    // The ending recalls the opening briefly and says something new: good repetition.
    expect(refs(craft(collapse, film()).findings, 'RETOLD_CONTENT')).toEqual([]);
  });
});

// ── Passenger candidates: what the viewer would miss (science) ───────────────

const lake = syntheticScope({
  question: 'Why did the lake turn red?',
  claims: [
    { key: 'L1', statement: 'The lake turned red in the summer of 1962.', importance: 'KEY' },
    { key: 'L2', statement: 'Scientists disagree whether algae or iron caused the colour.', verdict: 'DISPUTED', importance: 'KEY' },
    { key: 'L3', statement: 'The lake is 14 metres deep at its centre.', importance: 'BACKGROUND' },
    { key: 'L4', statement: 'Iron levels in the lake were three times normal in 1962 after the mine upstream reopened.', importance: 'SUPPORTING' },
  ],
  sequences: [
    { title: 'The colour', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'COLD_OPEN', claimKeys: ['L1'] }, { id: '1.2', basis: 'DOCUMENTED', claimKeys: ['L3'] }] },
    { title: 'The explanations', beats: [{ id: '2.1', basis: 'UNCERTAIN', function: 'INVESTIGATION', claimKeys: ['L2'] }, { id: '2.2', basis: 'DOCUMENTED', claimKeys: ['L4', 'L3'] }] },
  ],
});

describe('passenger candidates (science)', () => {
  const draft = (later: string, claims = ['L4']) =>
    syntheticDraft(lake, [
      [
        { text: 'In the summer of 1962 the lake turned red.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['L1'], extra: { centralQuestion: 'POSED' } },
        { text: 'The lake is 14 metres deep at its centre.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['L3'] },
      ],
      [
        { text: 'Scientists still disagree: algae, or iron.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['L2'] },
        { text: later, infoClass: 'DOCUMENTED', beatIds: ['2.2'], claimKeys: claims, extra: { centralQuestion: 'ANSWERED' } },
      ],
    ]);

  it('flags a fact that gives the viewer nothing the story needs — and not one a later section builds on', () => {
    const alone = craft(lake, draft('Iron levels were three times normal that year, because the mine upstream had reopened.')).findings;
    expect(refs(alone, 'PASSENGER_FACT')).toEqual(['1.2']);
    expect(of(alone, 'PASSENGER_FACT')[0]!.detail).toMatch(/^Block 1\.2 may be a passenger: nobody in it, no story beat, not a key claim or the question, no cause and effect, no open question, and no later section builds on it; it rests only on background claims — would the viewer miss it\?/);
    // The depth matters once the explanation uses it: no longer a passenger.
    const used = craft(lake, draft('At 14 metres, the iron from the reopened mine settled in the deepest water.', ['L4', 'L3'])).findings;
    expect(refs(used, 'PASSENGER_FACT')).toEqual([]);
    expect(dependentsOf(draft('At 14 metres, the iron from the reopened mine settled in the deepest water.', ['L4', 'L3'])).get('1.2')).toEqual(['2.2']);
  });

  it('never flags a block for an open question, cause and effect, or a person', () => {
    const fs = craft(lake, draft('Iron levels were three times normal that year, because the mine upstream had reopened.')).findings;
    expect(refs(fs, 'PASSENGER_FACT')).not.toContain('2.1');
    expect(refs(fs, 'PASSENGER_FACT')).not.toContain('2.2');
  });
});

describe('deliberate escalation and the writer’s own account', () => {
  it('does not count an escalating run of short sentences as repetitive openings', () => {
    const draft = syntheticDraft(history, [
      [
        { text: 'A fire destroyed the harbour of Corvel in 1771. Not one ship. Not one crate. Not one rope.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['H1'] },
        { text: 'Not one quay. Not one crane. Not one warehouse door.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['H1'] },
      ],
      [{ text: 'The harbourmaster, Elias Brandt, probably ordered the warehouses opened.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['H2'] }],
      [{ text: 'The town council rebuilt the quays within five years.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['H3'] }],
    ]);
    expect(detectRefrains(draft, history).filter((r) => r.kind === 'ESCALATION').map((r) => r.refs[0])).toEqual(['1.1', '1.2']);
    expect(of(checkScript(draft, history, { target: ONE_MINUTE }), 'REPETITIVE_OPENINGS')).toEqual([]);
  });

  it('notes when the writer misstates the length of what it wrote', () => {
    const timing = { words: 2319, totalSec: 959, targetSec: 750, minSec: 600, maxSec: 900, varianceSec: 209, fit: 'NEAR' as const };
    expect(selfReportMismatch('The narration runs to about 1,900 words, roughly 12:40.', timing)).toBe("The writer's change log claims 1,900 words and 12:40; measured: 2,319 words, 15:59");
    expect(selfReportMismatch('About 2,300 words, roughly 16 minutes.', timing)).toBeNull();
    expect(selfReportMismatch('Tighter and more spoken.', timing)).toBeNull();
    // A section's length, or a cut, is not a claim about the whole film.
    expect(selfReportMismatch('Section 3 is now 310 words and runs 2:05; the recap lost 45 seconds.', timing)).toBeNull();
  });
});

describe('the rules are generic', () => {
  it('name no documentary, person, place, date, claim, section or block — in any of the quality modules', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['craft.ts', 'evidence.ts', 'review.ts', 'performance.ts', 'wording.ts']) {
      const source = readFileSync(join(here, file), 'utf8');
      expect([file, /tulip|bulb|guilder|haarlem|amsterdam|alkmaar|thijs|mackay|semper|florist|goldgar|cuyck|orphan chamber|1636|1637/i.exec(source)?.[0] ?? null]).toEqual([file, null]);
      expect([file, /\bC\d{3}\b/.exec(source)?.[0] ?? null]).toEqual([file, null]);
      // No section or block singled out ("7", "3.4"), no phrase of a particular script.
      expect([file, /(?:section|sequence|ref|key)\s*===?\s*['"`]?\d/.exec(source)?.[0] ?? null]).toEqual([file, null]);
      expect([file, /['"`]\d+\.\d+['"`]/.exec(source)?.[0] ?? null]).toEqual([file, null]);
    }
  });
});
