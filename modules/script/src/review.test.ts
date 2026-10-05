import type { RuntimeTarget } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { allBlocks } from './draft.ts';
import { issueResolution, reviewPatch, reviewSummary } from './review.ts';
import type { ScriptPatch, WriterBlock } from './schemas.ts';
import { syntheticDraft, syntheticScope } from './testing.ts';

/**
 * Granular review on synthetic films (an investigation and a biography):
 * every change a reviewer proposes is judged on its own. None of this is the
 * acceptance documentary.
 */

const TARGET: RuntimeTarget = { minSec: 10, maxSec: 400, targetSec: 200 };
const ALL = new Set([1, 2, 3]);

// ── Investigation: conflicting accounts, resolved by an inquiry ──────────────

const investigation = syntheticScope({
  question: 'Who sank the ferry?',
  claims: [
    { key: 'I1', statement: 'The ferry Aster sank in the harbour on 3 March 1912.', importance: 'KEY' },
    { key: 'I2', statement: 'Witnesses disagreed about whether the captain was on the bridge.', verdict: 'DISPUTED', importance: 'KEY' },
    { key: 'I3', statement: 'An inquiry found the hull was probably weakened by an earlier collision.', verdict: 'PROBABLE', importance: 'KEY' },
    { key: 'I4', statement: 'Captain Lena Ostrom testified at the inquiry in 1913.', importance: 'SUPPORTING' },
    { key: 'I5', statement: 'Lena Ostrom sold the ferry company in 1920.', importance: 'SUPPORTING' },
  ],
  cast: [{ id: 'R1', name: 'Lena Ostrom', kind: 'REAL_PERSON', description: 'Captain of the ferry.', claimKeys: ['I4', 'I5'] }],
  sequences: [
    { title: 'The sinking', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'COLD_OPEN', claimKeys: ['I1'] }] },
    { title: 'The witnesses', beats: [{ id: '2.1', basis: 'UNCERTAIN', function: 'CONFLICT', claimKeys: ['I2'] }] },
    {
      title: 'The inquiry',
      beats: [
        { id: '3.1', basis: 'UNCERTAIN', function: 'REVEAL', claimKeys: ['I3'] },
        { id: '3.2', basis: 'DOCUMENTED', function: 'CONSEQUENCE', claimKeys: ['I4'], castIds: ['R1'] },
        { id: '3.3', basis: 'DOCUMENTED', function: 'CONSEQUENCE', claimKeys: ['I5'], castIds: ['R1'] },
      ],
    },
  ],
});

const inquiry = () =>
  syntheticDraft(investigation, [
    [
      { text: 'Who sank the ferry?', infoClass: 'FRAMING', extra: { centralQuestion: 'POSED' } },
      { text: 'On 3 March 1912 the ferry Aster sank in the harbour.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['I1'] },
    ],
    [{ text: 'Witnesses disagree about whether the captain was on the bridge.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['I2'] }],
    [
      { text: 'An inquiry found the hull was probably weakened by an earlier collision.', infoClass: 'UNCERTAIN', beatIds: ['3.1'], claimKeys: ['I3'], extra: { centralQuestion: 'ANSWERED' } },
      { text: 'Captain Lena Ostrom testified at the inquiry in 1913.', infoClass: 'DOCUMENTED', beatIds: ['3.2'], claimKeys: ['I4'] },
    ],
  ]);

const edit = (ref: string, text: string, reason: string, extra: Partial<ScriptPatch['edits'][number]> = {}): ScriptPatch['edits'][number] => ({ ref, reason, text, infoClass: null, claimKeys: null, beatIds: null, ...extra });
const framing = (text: string): WriterBlock => ({ text, infoClass: 'FRAMING', beatIds: [], claimKeys: [], speakerId: null, speechKind: null, visual: { intent: 'ON_SCREEN_TEXT', mustShow: [], mustAvoid: [], priority: 'NORMAL', note: '' } });

describe('granular review (investigation)', () => {
  const patch: ScriptPatch = {
    edits: [
      edit('2.1', 'Witnesses saw the captain on the bridge.', 'Plainer.'),
      edit('1.2', 'On 3 March 1912 the ferry Aster went down in the harbour, in sight of the quay.', 'A picture the viewer can hold.'),
      edit('3.1', 'The inquiry found the hull was weakened by an earlier collision.', 'Less hedging.'),
      edit('9.9', 'Nothing.', 'A block that does not exist.'),
      edit('3.2', 'Captain Lena Ostrom testified at the inquiry in 1913, and later she sold the ferry company.', 'Close her story.'),
      edit('3.1', 'An inquiry found the hull was probably weakened by an earlier collision.', 'Cite the opening fact instead.', { claimKeys: ['I1'] }),
    ],
    removals: [{ ref: '1.1', reason: 'The opening question slows the start.' }],
    insertions: [{ after: '2.1', reason: 'Turn the dispute into a question.', block: framing('So who was on the bridge?') }],
  };

  it('keeps the safe changes and rejects each unsafe one with the invariant it breaks', () => {
    const r = reviewPatch(inquiry(), patch, 'SCRIPT_EDITOR', { scope: investigation, target: TARGET, allowed: ALL, base: null });
    expect(r.changes.map((c) => `${c.id} ${c.type} ${c.ref} ${c.status}`)).toEqual([
      'E1 EDIT 2.1 REJECTED',
      'E2 EDIT 1.2 ACCEPTED',
      'E3 EDIT 3.1 REJECTED',
      'E4 EDIT 9.9 SKIPPED',
      'E5 EDIT 3.2 REJECTED',
      'E6 EDIT 3.1 REJECTED',
      'E7 REMOVE 1.1 REJECTED',
      'E8 INSERT 2.1 ACCEPTED',
    ]);
    const by = Object.fromEntries(r.changes.map((c) => [c.id, c]));
    expect(by.E1).toMatchObject({ rulesImpacted: ['DISPUTED_AS_FACT'], originalText: 'Witnesses disagree about whether the captain was on the bridge.', proposedText: 'Witnesses saw the captain on the bridge.', reason: 'Plainer.' });
    expect(by.E1!.rejectionReason).toBe('Violates uncertainty presentation — Block 2.1: I2 is DISPUTED but the narration does not say it is disputed [DISPUTED_AS_FACT]');
    expect(by.E3!.rejectionReason).toMatch(/^Violates uncertainty presentation — Block 3\.1: I3 is PROBABLE but the narration does not hedge it/);
    expect(by.E4!.rejectionReason).toBe('There is no block 9.9 in the version it reviewed');
    expect(by.E5).toMatchObject({ rulesImpacted: ['ASSERTION_UNCITED'] });
    expect(by.E5!.rejectionReason).toMatch(/^Violates claim relationships — Block 3\.2: "Captain Lena Ostrom testified .*" says of Lena Ostrom what I5 \(ESTABLISHED\) carries \(sell, company\), but the block does not cite I5/);
    expect(by.E6).toMatchObject({ rulesImpacted: ['CLAIM_LINK_LOST'] });
    expect(by.E6!.rejectionReason).toBe('Violates claim relationships — Block 3.1 keeps "An inquiry found the hull was probably weakened by an earlier…" from the version before, but no longer cites I3 (PROBABLE), the claim behind it — cite it, worded as its verdict requires, or cut the sentence [CLAIM_LINK_LOST]');
    expect(by.E7!.rejectionReason).toMatch(/^Violates the central narrative question — No block poses the central question/);
    expect(by.E2).toMatchObject({ savedRef: '1.2', rejectionReason: null });
    expect(by.E8).toMatchObject({ savedRef: '2.2', proposedText: 'So who was on the bridge?' });

    // The script: the two safe changes, nothing else.
    expect(allBlocks(r.draft).map((b) => `${b.key} ${b.text}`)).toEqual([
      '1.1 Who sank the ferry?',
      '1.2 On 3 March 1912 the ferry Aster went down in the harbour, in sight of the quay.',
      '2.1 Witnesses disagree about whether the captain was on the bridge.',
      '2.2 So who was on the bridge?',
      '3.1 An inquiry found the hull was probably weakened by an earlier collision.',
      '3.2 Captain Lena Ostrom testified at the inquiry in 1913.',
    ]);
    expect(r.keyMap.get('3.1')).toBe('3.1');
    expect(reviewSummary('Script editor', r.changes)).toBe('Script editor: 2 of 8 change(s) kept, 5 rejected, 1 skipped');
    // An issue whose fix was rejected stays open, and says why.
    expect(issueResolution('2.1', r).resolution).toMatch(/^open: its change E1 was rejected — Violates uncertainty presentation/);
    expect(issueResolution('1.2', r)).toEqual({ ref: '1.2', resolution: 'fixed by its own change (E2)' });
  });

  it('skips what cannot apply: a section the run may not change, a block already removed, a change that changes nothing', () => {
    const r = reviewPatch(
      inquiry(),
      {
        edits: [edit('1.2', 'On 3 March 1912 the ferry Aster sank in the harbour.', 'No change.'), edit('2.1', 'Witnesses disagree, the accounts differ, about the bridge.', 'Outside the run.'), edit('3.2', 'Captain Lena Ostrom testified at the inquiry in 1913.', 'After its removal.', { claimKeys: ['I4'] })],
        removals: [{ ref: '3.2', reason: 'A passenger.' }],
        insertions: [],
      },
      'FACT_CHECKER',
      { scope: investigation, target: TARGET, allowed: new Set([1, 3]), base: null },
    );
    expect(r.changes.map((c) => `${c.id} ${c.status}: ${c.rejectionReason}`)).toEqual([
      'F1 SKIPPED: It changes nothing',
      'F2 SKIPPED: Section 2 is not one this run may change',
      'F3 SKIPPED: It changes nothing',
      'F4 ACCEPTED: null',
    ]);
    expect(r.keyMap.get('3.2')).toBeNull();
  });
});

// ── Biography: a real person and a documented quotation ──────────────────────

const biography = syntheticScope({
  question: 'Why did she leave the observatory?',
  claims: [
    { key: 'Q1', statement: 'Mara Lind left the observatory in 1889.', importance: 'KEY' },
    { key: 'Q2', statement: 'Mara Lind wrote that the work had become a cage.', quote: 'The work had become a cage.', importance: 'KEY' },
  ],
  cast: [{ id: 'R1', name: 'Mara Lind', kind: 'REAL_PERSON', description: 'Astronomer who left the observatory.', claimKeys: ['Q1', 'Q2'] }],
  sequences: [{ title: 'The letter', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'TURN', claimKeys: ['Q1', 'Q2'], castIds: ['R1'] }] }],
});

describe('granular review (biography)', () => {
  it('rejects a change that alters a recorded quotation and keeps the one beside it', () => {
    const draft = syntheticDraft(biography, [
      [
        { text: 'In 1889 the astronomer Mara Lind left the observatory.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['Q1'], extra: { centralQuestion: 'POSED' } },
        { text: '"The work had become a cage."', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['Q2'], speakerId: 'R1', speechKind: 'RECORDED_QUOTE', extra: { centralQuestion: 'ANSWERED' } },
      ],
    ]);
    const r = reviewPatch(
      draft,
      {
        edits: [edit('1.2', '"The work had become a prison."', 'Stronger word.'), edit('1.1', 'In 1889 Mara Lind, an astronomer, walked out of the observatory.', 'A verb you can see.')],
        removals: [],
        insertions: [],
      },
      'SCRIPT_EDITOR',
      { scope: biography, target: TARGET, allowed: new Set([1]), base: null },
    );
    expect(r.changes.map((c) => `${c.id} ${c.status}`)).toEqual(['E1 REJECTED', 'E2 ACCEPTED']);
    expect(r.changes[0]!.rejectionReason).toMatch(/^Violates recorded-quote integrity — Block 1\.2: the words given to Mara Lind are not a verified quotation of Q2 \[UNVERIFIED_RECORDED_QUOTE\]/);
    expect(allBlocks(r.draft)[1]!.text).toBe('"The work had become a cage."');
    expect(allBlocks(r.draft)[0]!.text).toBe('In 1889 Mara Lind, an astronomer, walked out of the observatory.');
  });
});

// ── History with a fictional companion: the fiction boundary holds ────────────

const harbour = syntheticScope({
  question: 'Who opened the warehouses?',
  claims: [
    { key: 'H1', statement: 'A fire destroyed the harbour of Corvel in 1771.', importance: 'KEY' },
    { key: 'H2', statement: 'The harbourmaster Elias Brandt probably ordered the warehouses opened.', verdict: 'PROBABLE', importance: 'KEY' },
  ],
  cast: [
    { id: 'R1', name: 'Elias Brandt', kind: 'REAL_PERSON', description: 'Harbourmaster of Corvel.', claimKeys: ['H2'] },
    { id: 'F1', name: 'Mira', kind: 'FICTIONAL_COMPOSITE', description: 'An invented dock worker standing for the harbour labourers.' },
  ],
  sequences: [
    { title: 'The fire', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'COLD_OPEN', claimKeys: ['H1'] }, { id: '1.2', basis: 'FICTION', function: 'ORIENTATION', castIds: ['F1'] }] },
    { title: 'The order', beats: [{ id: '2.1', basis: 'UNCERTAIN', function: 'REVEAL', claimKeys: ['H2'], castIds: ['R1'] }, { id: '2.2', basis: 'RECONSTRUCTION', function: 'ESCALATION', claimKeys: ['H1'] }] },
  ],
});

describe('granular review (history with a fictional companion)', () => {
  it('rejects a change that lets fiction touch a real person, or turns a reconstruction into "what probably happened"; keeps a plain improvement', () => {
    const draft = syntheticDraft(harbour, [
      [
        { text: 'In 1771 a fire destroyed the harbour of Corvel.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['H1'], extra: { centralQuestion: 'POSED' } },
        { text: 'Mira, an invented dock worker, watches the smoke from the quay.', infoClass: 'FICTION', beatIds: ['1.2'] },
      ],
      [
        { text: 'The harbourmaster, Elias Brandt, probably ordered the warehouses opened.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['H2'], extra: { centralQuestion: 'ANSWERED' } },
        { text: 'The quay is crowded. Smoke hangs over the water.', infoClass: 'RECONSTRUCTION', beatIds: ['2.2'], claimKeys: ['H1'] },
      ],
    ]);
    const r = reviewPatch(
      draft,
      {
        edits: [
          edit('1.2', 'Mira hands Brandt the warehouse keys.', 'Put her at the centre.'),
          edit('2.2', 'What probably happened next is simple: the crowd broke the doors.', 'Say what happened.'),
          edit('1.1', 'In 1771 fire took the harbour of Corvel.', 'Shorter.'),
        ],
        removals: [],
        insertions: [],
      },
      'SCRIPT_EDITOR',
      { scope: harbour, target: TARGET, allowed: new Set([1, 2]), base: null },
    );
    expect(r.changes.map((c) => `${c.id} ${c.status}`)).toEqual(['E1 REJECTED', 'E2 REJECTED', 'E3 ACCEPTED']);
    expect(r.changes[0]!.rejectionReason).toMatch(/^Violates fictional-character boundaries — Block 1\.2: a fictional character and a real person interact/);
    expect(r.changes[1]!.rejectionReason).toMatch(/^Violates uncertainty presentation — Block 2\.2: "What probably happened" presents a reconstruction as probable history/);
    expect(allBlocks(r.draft).map((b) => b.text)).toEqual([
      'In 1771 fire took the harbour of Corvel.',
      'Mira, an invented dock worker, watches the smoke from the quay.',
      'The harbourmaster, Elias Brandt, probably ordered the warehouses opened.',
      'The quay is crowded. Smoke hangs over the water.',
    ]);
  });
});
