import { fixtureDraft, fixtureScope } from '@docengine/script/testing';
import { describe, expect, it } from 'vitest';
import { buildSpine, SpineIntegrityError } from './spine.ts';
import { domainFilm, sketchDraft, syntheticSpine, withRowIds } from './testing.ts';
import { timeStoryboard } from './timing.ts';

/**
 * The narration spine on assemblies built by the voice engine's own
 * assemble(): words mapped to blocks by character offset across multi-span
 * chunks and split blocks, untimed words kept but never cut at, takes with
 * no word timings cut only at their clip edges, explicit silences, the cut
 * point catalogue, and the cross-check against the stored timeline.
 */

const history = () => domainFilm('history');

describe('words and blocks', () => {
  it('maps every word to its block, in order, with times from the take the entry names', () => {
    const { facts } = history();
    const spine = facts.spine;
    expect(spine.blocks.map((b) => b.key)).toEqual(['1.1', '1.2', '1.3', '2.1', '2.2', '3.1']);
    expect(spine.words.filter((w) => w.blockKey === '1.1').map((w) => w.text)).toEqual(['Who', 'opened', 'the', 'warehouses']);
    expect(spine.words.every((w, i) => w.index === i && w.timed)).toBe(true);
    // Times are on the assembled clock: each word after the one before it.
    expect(spine.words.every((w, i) => i === 0 || w.startMs >= spine.words[i - 1]!.endMs)).toBe(true);
    expect(spine.blocks[1]!.sceneId).toBe('scene-SC01');
    expect(spine.blocks[3]!.sectionKey).toBe('SC02');
    expect(spine.totalDurationMs).toBe(spine.narration.assembly.totalDurationMs);
  });

  it('reads several blocks in one chunk and one block split over two chunks by character offset', () => {
    const { scope, script } = history();
    const narration = syntheticSpine(script, { chunks: [['1.1', '1.2'], ['1.3'], ['2.1', '2.2'], ['3.1']], split: { '1.3': 10 } });
    const spine = buildSpine(narration, script);
    void scope;
    const w13 = spine.words.filter((w) => w.blockKey === '1.3');
    expect(w13.map((w) => w.word)).toEqual([...Array(w13.length).keys()]);
    expect(new Set(w13.map((w) => w.entry)).size).toBe(2);
    // The split falls inside a sentence: a clip edge there is a (mid-sentence) pause point.
    expect(spine.point('1.3:10')).toMatchObject({ kind: 'PAUSE', midSentence: true, clipEdge: true });
    const w12 = spine.words.filter((w) => w.blockKey === '1.2');
    expect(new Set(w12.map((w) => w.entry))).toEqual(new Set([spine.words[0]!.entry]));
  });

  it('reads the take each entry names, never another take of the chunk', () => {
    const { script } = history();
    const narration = syntheticSpine(script);
    const entry = narration.entries[1]!;
    const take = narration.takes.find((t) => t.id === entry.generationId)!;
    const other = { ...structuredClone(take), id: 'g-other', alignment: { ...take.alignment!, words: take.alignment!.words.map((w) => ({ ...w, startMs: w.startMs + 5000, endMs: w.endMs + 5000 })) } };
    const spine = buildSpine({ ...narration, takes: [...narration.takes, other] }, script);
    expect(spine.words.find((w) => w.blockKey === '1.2')!.startMs).toBe(entry.startMs + take.alignment!.words[0]!.startMs);
  });

  it('keeps an untimed word in place, interpolates it for display only, and never cuts beside it', () => {
    const { script } = history();
    const spine = buildSpine(syntheticSpine(script, { untimed: ['1.2:9', '1.2:10'] }), script);
    const [a, b] = spine.words.filter((w) => w.blockKey === '1.2' && (w.word === 9 || w.word === 10));
    expect([a!.timed, b!.timed]).toEqual([false, false]);
    const before = spine.words[a!.index - 1]!;
    const after = spine.words[b!.index + 1]!;
    expect(a!.startMs).toBeGreaterThanOrEqual(before.endMs);
    expect(b!.endMs).toBeLessThanOrEqual(after.startMs);
    // "The flames…" starts a sentence at word 9, but its first word has no timestamp: no cut point there.
    expect(spine.point('1.2:9')).toBeUndefined();
    expect(spine.point('1.2:10')).toBeUndefined();
    expect(spine.point('1.2:11')).toBeUndefined();
  });

  it('offers only the clip edges of a take with no word timings, and estimates nothing inside it', () => {
    const { script } = history();
    const spine = buildSpine(syntheticSpine(script, { missingAlignment: ['1.3'] }), script);
    const take = spine.words.find((w) => w.blockKey === '1.3')!.takeId;
    expect(spine.unalignedTakes).toEqual([take]);
    const inside = spine.points.filter((p) => p.position > spine.block('1.3')!.first && p.position <= spine.block('1.3')!.last);
    expect(inside).toEqual([]);
    const entry = spine.narration.entries.find((e) => e.generationId === take)!;
    // Its edges are the clip's real start and end.
    expect(spine.point('1.2:end')!.silence.endMs).toBe(entry.startMs);
    expect(spine.point('1.3:end')!.silence.startMs).toBe(entry.endMs);
    expect(spine.words.filter((w) => w.blockKey === '1.3').every((w) => !w.timed && w.startMs >= entry.startMs && w.endMs <= entry.endMs)).toBe(true);
  });

  it('bounds blocks and rows only by real audio: blocks in one untimed take share its clip, never a split by word count', () => {
    const { script, facts } = domainFilm('history', { chunks: [['1.1'], ['1.2', '1.3'], ['2.1'], ['2.2'], ['3.1']], missingAlignment: ['1.2', '1.3'] });
    const entry = facts.spine.narration.entries[1]!;
    const clip = [entry.startMs, entry.endMs];
    expect([facts.spine.block('1.2')!, facts.spine.block('1.3')!].map((b) => [b.startMs, b.endMs])).toEqual([clip, clip]);
    expect(facts.spine.points.map((p) => p.id).slice(0, 3)).toEqual(['⟨start⟩', '1.1:end', '1.3:end']);
    const t = timeStoryboard(sketchDraft(facts, [{ to: '1.1:end' }, { to: '1.3:end' }, { to: '⟨end⟩' }]), facts.spine);
    expect(t.shots.get('SH002')!.blocks.map((r) => [r.blockKey, r.startMs, r.endMs])).toEqual([
      ['1.2', ...clip],
      ['1.3', ...clip],
    ]);
    // An untimed word at a row's edge widens it to the timed word beside it.
    const untimed = buildSpine(syntheticSpine(script, { untimed: ['1.2:0'] }), script);
    const first = untimed.words.find((w) => w.blockKey === '1.2' && w.word === 0)!;
    const clipOf = untimed.narration.entries[first.entry]!;
    expect(first.heard).toEqual({ startMs: clipOf.startMs, endMs: untimed.words[first.index + 1]!.startMs });
    expect(untimed.block('1.2')!.startMs).toBe(clipOf.startMs);
  });
});

describe('silences and cut points', () => {
  it('lists silences longer than 120 ms: the edges, scripted pauses and the gaps between clips', () => {
    const { script } = history();
    const spine = buildSpine(syntheticSpine(script, { pauses: { '1.2:4': 600 } }), script);
    const pause = spine.silences.find((s) => s.endMs === spine.words.find((w) => w.blockKey === '1.2' && w.word === 4)!.startMs);
    expect(pause!.endMs - pause!.startMs).toBe(640);
    expect(spine.silences[0]).toEqual({ startMs: 0, endMs: 200 });
    expect(spine.silences.at(-1)!.endMs).toBe(spine.totalDurationMs);
    // No 40 ms gap between two words of a take is a silence.
    expect(spine.silences.every((s) => s.endMs - s.startMs > 120)).toBe(true);
  });

  it('catalogues the scope edges, blocks, sections, sentences, clauses and long pauses — nothing else', () => {
    const { script } = history();
    const spine = buildSpine(syntheticSpine(script, { pauses: { '1.3:4': 450, '2.2:3': 300 } }), script);
    const kinds = Object.fromEntries(spine.points.map((p) => [p.id, p.kind]));
    expect(kinds).toMatchObject({
      '⟨start⟩': 'SCOPE_EDGE',
      '1.1:end': 'BLOCK',
      '1.2:2': 'CLAUSE', // "In 1771, a fire destroyed…"
      '1.2:9': 'SENTENCE', // "The flames…"
      '1.3:end': 'SECTION',
      '1.3:4': 'PAUSE', // 450 ms inside a sentence
      '⟨end⟩': 'SCOPE_EDGE',
    });
    // A 300 ms pause inside a sentence is not a cut point; nor is a comma with fewer than three words after it.
    expect(spine.point('2.2:3')).toBeUndefined();
    expect(spine.point('1.1:end')!.aliases).toEqual(['1.2:0']);
    expect(spine.point('1.2:0')).toBe(spine.point('1.1:end'));
    expect(spine.point('1.1:0')).toBe(spine.point('⟨start⟩'));
    expect(spine.point('3.1:end')).toBe(spine.point('⟨end⟩'));
    expect(spine.point('1.2:2')).toMatchObject({ midSentence: true });
    expect(spine.point('1.2:9')).toMatchObject({ midSentence: false });
    // The default cut is the middle of the silence; the scope's edges are 0 and the end.
    const p = spine.point('1.1:end')!;
    expect(p.atMs).toBe(Math.round(p.silence.startMs + (p.silence.endMs - p.silence.startMs) / 2));
    expect(spine.point('⟨start⟩')!.atMs).toBe(0);
    expect(spine.point('⟨end⟩')!.atMs).toBe(spine.totalDurationMs);
    // Positions are in clock order.
    expect(spine.points.every((x, i) => i === 0 || x.position > spine.points[i - 1]!.position)).toBe(true);
  });

  it('counts the blocks a preview leaves out of scope (never estimates them)', () => {
    const scope = fixtureScope();
    const script = withRowIds(fixtureDraft(scope));
    const spine = buildSpine(syntheticSpine(script, { blocks: ['1.1', '1.2', '1.3'] }), script);
    expect(spine.blocks.map((b) => b.key)).toEqual(['1.1', '1.2', '1.3']);
    expect(spine.outOfScope.map((b) => b.key)).toEqual(['1.4', '1.5', '2.1', '2.2', '3.1', '3.2', '3.3']);
    expect(spine.point('⟨end⟩')!.aliases).toEqual(['1.3:end']);
  });
});

describe('integrity: the narration must belong to the script', () => {
  it('refuses word times that differ from the stored timeline', () => {
    const { script } = history();
    const narration = syntheticSpine(script);
    narration.timeline[2]!.words[0]!.startMs += 7;
    expect(() => buildSpine(narration, script)).toThrow(SpineIntegrityError);
    expect(() => buildSpine(narration, script)).toThrow(/differ from the assembly's stored timeline/);
  });

  it('refuses narration of other text, another version of a block, or a block the script lacks', () => {
    const { script } = history();
    const narration = syntheticSpine(script);
    const edited = structuredClone(script);
    edited.sections[0]!.blocks[1]!.text = edited.sections[0]!.blocks[1]!.text.replace('fire', 'blaze');
    expect(() => buildSpine(narration, edited)).toThrow(/narrated text differs/);
    const other = structuredClone(script);
    other.sections[0]!.blocks[1]!.rowId = 'b-other-version';
    expect(() => buildSpine(narration, other)).toThrow(/another version or language/);
    const shorter = structuredClone(script);
    shorter.sections[2]!.blocks = [];
    expect(() => buildSpine(narration, shorter)).toThrow(/not in the script/);
  });

  it('refuses a script not loaded from its rows (no ids to link)', () => {
    const { script } = history();
    const narration = syntheticSpine(script);
    const bare = structuredClone(script);
    delete bare.sections[0]!.blocks[0]!.rowId;
    expect(() => buildSpine(narration, bare)).toThrow(/no row id/);
  });

  it('refuses a run whose scope names a block that is not narrated in full', () => {
    const { script } = history();
    const narration = syntheticSpine(script, { blocks: ['1.1', '1.2'] });
    expect(() => buildSpine({ ...narration, run: { ...narration.run, scopeBlockKeys: ['1.1', '1.2', '1.3'] } }, script)).toThrow(/block 1\.3 is not narrated in full/);
  });
});
