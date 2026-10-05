import { describe, expect, it } from 'vitest';
import { compareDrafts, diffBlocks, evidenceChanges, wordDiff } from './compare.ts';
import { allBlocks, applyPatch, applyPerformance, mergePronunciations, sectionsFromWriter } from './draft.ts';
import type { WriterBlock } from './schemas.ts';
import { fixtureDraft, fixtureScope } from './testing.ts';

const scope = fixtureScope();
const block = (text: string, extra: Partial<WriterBlock> = {}): WriterBlock => ({ text, infoClass: 'DOCUMENTED', beatIds: ['2.2'], claimKeys: ['C007'], speakerId: null, speechKind: null, visual: { intent: 'DOCUMENT', mustShow: [], mustAvoid: [], priority: 'NORMAL', note: '' }, ...extra });

describe('a draft from the writer', () => {
  it('has one section per sequence asked for, in architecture order, with keys, timing and presentation derived', () => {
    const notes: string[] = [];
    const sections = sectionsFromWriter(
      {
        sections: [
          { sequence: 2, blocks: [block('In April 1637 the courts sent the contracts back.', { claimKeys: ['C007', 'C999'], beatIds: ['2.2', '9.9'] })] },
          { sequence: 7, blocks: [block('Out of scope.')] },
        ],
        centralQuestion: { posedIn: '2.1', answeredIn: '5.5' },
        changeLog: { summary: '', changes: [] },
      },
      scope,
      [1, 2],
      new Map(),
      notes,
    );
    expect(sections.map((s) => `${s.key} ${s.blocks.map((b) => b.key).join(',')}`)).toEqual(['SC01 ', 'SC02 2.1']);
    expect(sections[1]!.blocks[0]).toMatchObject({ claimKeys: ['C007'], beatIds: ['2.2'], centralQuestion: 'POSED', wordCount: 10, generatedText: 'In April 1637 the courts sent the contracts back.' });
    expect(notes).toEqual([
      'The writer returned section 7, which was not asked for; ignored',
      'Block 2.1: C999 not in the approved dossier; dropped',
      'Block 2.1: beat 9.9 is not in the architecture; dropped',
      'The central question is answered in 5.5, which is not a block of the script; ignored',
    ]);
  });
});

describe('a reviewer patch', () => {
  it('edits, removes and inserts blocks it may change, renumbers, and says where every block went', () => {
    const d = fixtureDraft(scope);
    const notes: string[] = [];
    const r = applyPatch(
      d,
      {
        edits: [{ ref: '2.2', text: 'In April 1637 the courts declined to enforce the contracts.', infoClass: null, claimKeys: null, beatIds: null }],
        removals: ['2.1'],
        insertions: [{ after: '2.0', block: block('The courts had a choice to make.', { infoClass: 'FRAMING', beatIds: [], claimKeys: [] }) }],
      },
      scope,
      new Set([2]),
      'Fact checker',
      notes,
    );
    expect(r.changed).toBe(3);
    expect(r.draft.sections[1]!.blocks.map((b) => `${b.key} ${b.text}`)).toEqual(['2.1 The courts had a choice to make.', '2.2 In April 1637 the courts declined to enforce the contracts.']);
    expect(r.keyMap.get('2.1')).toBeNull();
    expect(r.keyMap.get('2.2')).toBe('2.2');
    // Sections outside the allowed set are not touched.
    const outside = applyPatch(d, { edits: [{ ref: '1.2', text: 'Changed.', infoClass: null, claimKeys: null, beatIds: null }], removals: [], insertions: [] }, scope, new Set([2]), 'Script editor', notes);
    expect(outside.changed).toBe(0);
    expect(notes).toContain('Script editor: edit of 1.2 skipped (no such block it may change)');
    // The original draft is unchanged.
    expect(d.sections[1]!.blocks.map((b) => b.key)).toEqual(['2.1', '2.2']);
  });
});

describe('the performance pass', () => {
  it('sets delivery only where listed, keeps emphasis to words in the text, and flags pronunciations to check', () => {
    const d = fixtureDraft(scope);
    const notes: string[] = [];
    const out = applyPerformance(
      d,
      {
        blocks: [{ ref: '3.1', pace: 'SLOW', energy: 'LOW', emotion: 'SOMBER', emphasis: [{ text: 'archives', level: 'STRONG' }, { text: 'nowhere', level: 'LIGHT' }], pauseBefore: { length: 'SHORT', reason: 'TRANSITION' }, pauseAfter: { length: 'LONG', reason: 'REVEAL' } }],
        pronunciations: [{ term: 'Proefman', respelling: 'PROOF-mahn', ipa: null, language: 'Dutch', confidence: 'MEDIUM', note: 'Check (test).' }],
        notes: [],
      },
      scope,
      new Set([1, 2, 3]),
      notes,
    );
    const b = allBlocks(out).find((x) => x.key === '3.1')!;
    expect(b.delivery).toMatchObject({ pace: 'SLOW', emotion: 'SOMBER', emphasis: [{ text: 'archives', level: 'STRONG' }], pauseAfter: { length: 'LONG', reason: 'REVEAL' } });
    expect(allBlocks(out).filter((x) => x.key !== '3.1').every((x) => x.delivery.pace === 'NORMAL' && x.delivery.pauseAfter.length === 'NONE')).toBe(true);
    expect(notes).toEqual(['Performance: emphasis on "nowhere" in 3.1 is not in its text; dropped']);
    expect(out.pronunciations).toEqual([{ term: 'Proefman', respelling: 'PROOF-mahn', ipa: null, language: 'Dutch', confidence: 'MEDIUM', note: 'Check (test).', needsReview: true, source: 'MODEL' }]);
  });

  it('never replaces an editor-confirmed pronunciation with a model one', () => {
    const editor = { term: 'Proefman', respelling: 'PROOF-man', ipa: null, language: 'Dutch', confidence: 'HIGH' as const, note: '', needsReview: false, source: 'EDITOR' as const };
    const model = { ...editor, respelling: 'PROFF-man', source: 'MODEL' as const, needsReview: true };
    expect(mergePronunciations([editor], [model])).toEqual([editor]);
  });
});

describe('comparing versions', () => {
  it('lists blocks as unchanged, removed or added, in order', () => {
    const d = fixtureDraft(scope);
    const a = d.sections[1]!.blocks;
    const b = [a[0]!, { ...a[1]!, text: 'The courts sent the contracts back to the towns.' }];
    expect(diffBlocks(a, b).map((x) => `${x.op}: ${x.text}`)).toEqual([
      `same: ${a[0]!.text}`,
      `added: The courts sent the contracts back to the towns.`,
      `removed: ${a[1]!.text}`,
    ]);
  });

  it('counts the words removed and added, and whether the evidence moved', () => {
    expect(wordDiff('the court sent the contracts back'.split(' '), 'in the end the court sent them back'.split(' '))).toEqual({ removed: 2, added: 4 });
    expect(wordDiff([], ['a', 'b'])).toEqual({ removed: 0, added: 2 });
    const d = fixtureDraft(scope);
    const refined = { ...d, sections: d.sections.map((s) => (s.sequence === 2 ? { ...s, blocks: [{ ...s.blocks[0]!, text: `${s.blocks[0]!.text} Plainly.` }, ...s.blocks.slice(1)] } : s)) };
    const cmp = compareDrafts(d, refined);
    expect(cmp.totals).toMatchObject({ sectionsChanged: 1, wordsRemoved: 0, wordsAdded: 1 });
    expect(cmp.sections[1]!.words).toMatchObject({ removed: 0, added: 1 });
    expect(evidenceChanges(d, refined)).toEqual({ claimsAdded: [], claimsRemoved: [], figuresAdded: [], figuresRemoved: [] });
    // Section 2 replaced by one block citing a new claim and saying a new figure: what it dropped is listed too.
    const moved = { ...d, sections: d.sections.map((s) => (s.sequence === 2 ? { ...s, blocks: [{ ...s.blocks[0]!, text: 'Some 7,123 people watched.', claimKeys: ['C999'] }] } : s)) };
    const before = new Set(d.sections[1]!.blocks.flatMap((b) => b.claimKeys));
    const elsewhere = new Set(d.sections.filter((s) => s.sequence !== 2).flatMap((s) => s.blocks.flatMap((b) => b.claimKeys)));
    expect(evidenceChanges(d, moved)).toMatchObject({ claimsAdded: ['C999'], claimsRemoved: [...before].filter((k) => !elsewhere.has(k)).sort(), figuresAdded: ['7123'] });
  });
});
