import { describe, expect, it } from 'vitest';
import { buildSpine } from './spine.ts';
import { domainFilm, sketchDraft, syntheticSpine } from './testing.ts';
import { timeStoryboard } from './timing.ts';

/**
 * From cut points to times: the visual track tiles the clock by
 * construction; lead-ins and tail-outs are requested by cut point and kept
 * only within the limits; silence-only shots sit in their silence; a
 * person's nudge stays within ±2 s; and re-timing onto another assembly of
 * the same script keeps every anchor and moves only the milliseconds.
 */

const history = () => domainFilm('history');
const tiles = (shots: { startMs: number; endMs: number }[], total: number) => {
  const sorted = [...shots].sort((a, b) => a.startMs - b.startMs);
  return sorted[0]!.startMs === 0 && sorted.at(-1)!.endMs === total && sorted.every((s, i) => i === 0 || s.startMs === sorted[i - 1]!.endMs);
};

describe('the partition and the tiling', () => {
  it('cuts at the middle of each shared silence, from 0 to the end, with many shots in a block and one shot across blocks', () => {
    const { facts } = history();
    const draft = sketchDraft(facts, [
      { to: '1.2:end', shots: [{ to: '1.2:2' }, { to: '1.2:9' }, {}] },
      { to: '1.3:end' },
      { to: '2.2:end', shots: [{}] },
      { to: '⟨end⟩' },
    ]);
    // The first beat's shots: one across 1.1 and the start of 1.2, then two more inside 1.2.
    const t = timeStoryboard(draft, facts.spine);
    const g = [...t.shots.values()];
    expect(t.missing.size).toBe(0);
    expect(tiles(g, facts.spine.totalDurationMs)).toBe(true);
    const sh1 = t.shots.get('SH001')!;
    expect(sh1.blocks.map((b) => b.blockKey)).toEqual(['1.1', '1.2']);
    expect(sh1.blocks[1]).toMatchObject({ firstWord: 0, lastWord: 1 });
    expect(sh1.endMs).toBe(facts.spine.point('1.2:2')!.atMs);
    expect(t.shots.get('SH002')!.blocks).toEqual([expect.objectContaining({ blockKey: '1.2', firstWord: 2, lastWord: 8 })]);
    // One shot over two whole blocks of a section: 2.1 and 2.2.
    expect(t.shots.get('SH005')!.blocks.map((b) => b.blockKey)).toEqual(['2.1', '2.2']);
    expect(t.shots.get('SH005')!.relation).toBe('TIMED_TO_NARRATION');
    // A default cut is never reported as an overlap.
    expect(g.every((x) => x.timing.leadInMs === 0 && x.timing.tailOutMs === 0)).toBe(true);
    expect(t.beats.get('VB01')).toMatchObject({ startMs: 0, endMs: t.shots.get('SH003')!.endMs });
    expect(t.beats.get('VB01')!.blocks.map((b) => b.blockKey)).toEqual(['1.1', '1.2']);
  });

  it('marks a shot across a section boundary as a bridge, and records the takes heard under each shot', () => {
    const { facts } = history();
    const t = timeStoryboard(sketchDraft(facts, [{ to: '1.2:end' }, { to: '2.1:end' }, { to: '⟨end⟩' }]), facts.spine);
    const sh2 = t.shots.get('SH002')!;
    expect(sh2.relation).toBe('BRIDGE');
    expect(sh2.timing.bridge).toEqual({ kind: 'SECTION', fromBlockId: 'b1.3', toBlockId: 'b2.1' });
    expect(sh2.timing.audio.map((a) => a.generationId)).toEqual(['g2', 'g3']);
    expect(sh2.sceneId).toBe('scene-SC01');
    expect(sh2.narrationAnchor).toBe('1.2:end–2.1:end');
    expect(t.shots.get('SH001')!.narrationAnchor).toBe('1.1:0–1.2:end');
  });
});

describe('lead-ins and tail-outs, requested by cut point', () => {
  it('keeps a lead-in inside the neighbour within a sentence or 2 s, and reports it as LEAD_IN', () => {
    const { facts } = history();
    const draft = sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.2:9' }, { visualFrom: '1.2:2' }] }, { to: '⟨end⟩' }]);
    // 1.2:2 → 1.2:9 is one sentence: allowed, though it moves the cut more than 2 s.
    const t = timeStoryboard(draft, facts.spine);
    const sh2 = t.shots.get('SH002')!;
    const p = facts.spine.point('1.2:2')!;
    expect(sh2.startMs).toBe(p.atMs);
    expect(sh2.relation).toBe('LEAD_IN');
    expect(sh2.timing.leadInMs).toBe(facts.spine.point('1.2:9')!.atMs - p.atMs);
    expect(sh2.timing.visualFrom).toBe('1.2:2');
    expect(t.shots.get('SH001')!.endMs).toBe(p.atMs);
    expect(t.notes).toEqual([]);
  });

  it('drops a lead-in outside the neighbour, beyond a sentence and 2 s, or that leaves it too short — and notes why', () => {
    const { facts } = history();
    const cases: [string, RegExp][] = [
      ['1.3:9', /not inside the words of SH001/],
      ['1.2:end', /not inside the words of SH001/],
    ];
    for (const [id, why] of cases) {
      const t = timeStoryboard(sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.2:9' }, { visualFrom: id }] }, { to: '⟨end⟩' }]), facts.spine);
      expect(t.notes).toEqual([expect.stringMatching(new RegExp(`^SH002: dropped the lead-in from ${id.replace(/[.]/g, '\\.')} — .*${why.source}`))]);
      expect(t.anchors.get('SH002')!.visualFrom).toBeNull();
      expect(t.shots.get('SH002')!.relation).toBe('TIMED_TO_NARRATION');
    }
    // Two sentences back, more than 2 s: refused.
    const far = timeStoryboard(sketchDraft(facts, [{ to: '1.3:16', shots: [{ to: '1.3:1' }, {}] }, { to: '⟨end⟩', shots: [{ visualFrom: '1.3:9' }] }]), facts.spine);
    expect(far.notes).toEqual([]);
    const tooFar = timeStoryboard(sketchDraft(facts, [{ to: '1.3:16', shots: [{ to: '1.2:2' }, {}] }, { to: '⟨end⟩', shots: [{ visualFrom: '1.2:9' }] }]), facts.spine);
    expect(tooFar.notes).toEqual([expect.stringMatching(/^SH003: dropped the lead-in from 1\.2:9 — it moves the cut by more than one sentence and 2 s/)]);
    // The neighbour would be shorter than its minimum: a lead-in from its first clause.
    const short = timeStoryboard(sketchDraft(facts, [{ to: '1.3:9', shots: [{ to: '1.3:1' }, {}] }, { to: '⟨end⟩', shots: [{ visualFrom: '1.3:1' }] }]), facts.spine);
    expect(short.notes.join()).toMatch(/not inside the words of SH002/);
  });

  it('keeps a tail-out over the next shot\'s first words, refuses a second request at the same cut', () => {
    const { facts } = history();
    const t = timeStoryboard(sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.2:2', visualTo: '1.2:9' }, {}] }, { to: '⟨end⟩' }]), facts.spine);
    const sh1 = t.shots.get('SH001')!;
    expect(sh1.relation).toBe('TAIL_OUT');
    expect(sh1.timing.tailOutMs).toBe(facts.spine.point('1.2:9')!.atMs - facts.spine.point('1.2:2')!.atMs);
    const both = timeStoryboard(sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.2:9', visualTo: '1.2:end' }, { visualFrom: '1.2:2' }] }, { to: '⟨end⟩' }]), facts.spine);
    expect(both.notes).toEqual([expect.stringMatching(/^SH001: dropped the tail-out to 1\.2:end — SH002 already leads in at this cut/)]);
  });

  it('marks a lead-in under the previous beat\'s words as a bridge across beats', () => {
    const { facts } = history();
    const t = timeStoryboard(sketchDraft(facts, [{ to: '1.2:9' }, { to: '1.2:end', shots: [{ visualFrom: '1.2:2' }] }, { to: '⟨end⟩' }]), facts.spine);
    expect(t.shots.get('SH002')!.timing.bridge?.kind).toBe('BEAT');
    expect(t.shots.get('SH002')!.relation).toBe('BRIDGE');
    expect(t.shots.get('SH002')!.timing.leadInMs).toBeGreaterThan(0);
  });
});

describe('silence-only shots and nudges', () => {
  it('puts a silence-only shot in its silence, the neighbours cutting at its edges', () => {
    const { facts } = history();
    // The section change after 1.3 is a 1 s silence.
    const t = timeStoryboard(sketchDraft(facts, [{ to: '1.3:end', shots: [{}, { silenceAt: '1.3:end', treatment: 'TRANSITION' }] }, { to: '⟨end⟩' }]), facts.spine);
    const p = facts.spine.point('1.3:end')!;
    const silent = t.shots.get('SH002')!;
    expect([silent.startMs, silent.endMs]).toEqual([p.silence.startMs, p.silence.endMs]);
    expect(silent.timing).toMatchObject({ narration: null, silenceAt: '1.3:end', narrationStartMs: null, leadInMs: 0, tailOutMs: 0, bridge: { kind: 'SILENCE', fromBlockId: 'b1.3', toBlockId: 'b2.1' } });
    expect(silent.relation).toBe('BRIDGE');
    expect(t.shots.get('SH001')!.endMs).toBe(p.silence.startMs);
    expect(t.shots.get('SH003')!.startMs).toBe(p.silence.endMs);
    expect(tiles([...t.shots.values()], facts.spine.totalDurationMs)).toBe(true);
  });

  it('does not place a silence-only shot inside another shot\'s words: the others tile as if it were not there', () => {
    const { facts } = domainFilm('history', { pauses: { '1.2:5': 900 } });
    const t = timeStoryboard(sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.2:end' }, { silenceAt: '1.2:5' }] }, { to: '⟨end⟩' }]), facts.spine);
    expect(t.missing.get('SH002')).toBe('its silence 1.2:5 lies inside the words of SH001');
    expect(t.shots.has('SH002')).toBe(false);
    expect(t.shots.get('SH001')!.endMs).toBe(facts.spine.point('1.2:end')!.atMs);
    expect(t.shots.get('SH003')!.timing.leadInMs).toBe(0);
    expect(tiles([...t.shots.values()], facts.spine.totalDurationMs)).toBe(true);
  });

  it('applies a person\'s nudge within ±2 s, and reduces one that would leave a neighbour too short (noted)', () => {
    const { facts } = history();
    const nudged = timeStoryboard(sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.2:9' }, { cutOffsetMs: -300 }] }, { to: '⟨end⟩' }]), facts.spine);
    expect(nudged.shots.get('SH002')!.startMs).toBe(facts.spine.point('1.2:9')!.atMs - 300);
    expect(nudged.shots.get('SH001')!.endMs).toBe(facts.spine.point('1.2:9')!.atMs - 300);
    expect(nudged.shots.get('SH002')!.timing.cutOffsetMs).toBe(-300);
    expect(nudged.shots.get('SH002')!.relation).toBe('LEAD_IN');
    const short = timeStoryboard(sketchDraft(facts, [{ to: '1.1:end' }, { to: '⟨end⟩', shots: [{ cutOffsetMs: -2000 }] }]), facts.spine);
    expect(short.notes).toEqual([expect.stringMatching(/^SH002: the cut nudge of -2000 ms was reduced to -\d+ ms/)]);
    expect(short.shots.get('SH001')!.endMs - short.shots.get('SH001')!.startMs).toBe(700);
  });
});

describe('re-timing', () => {
  it('keeps every anchor on another assembly of the same script and moves only the times', () => {
    const { facts, script } = history();
    const draft = sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.2:9' }, {}] }, { to: '⟨end⟩', shots: [{ to: '2.1:end' }, {}] }]);
    const before = timeStoryboard(draft, facts.spine);
    const slower = buildSpine(syntheticSpine(script, { msPerWord: 520, pauses: { '1.2:4': 700 } }), script);
    const after = timeStoryboard(draft, slower);
    for (const key of ['SH001', 'SH002', 'SH003', 'SH004']) {
      expect(after.shots.get(key)!.timing.narration).toEqual(before.shots.get(key)!.timing.narration);
      expect(after.shots.get(key)!.blocks.map((b) => [b.blockKey, b.firstWord, b.lastWord])).toEqual(before.shots.get(key)!.blocks.map((b) => [b.blockKey, b.firstWord, b.lastWord]));
    }
    expect(after.shots.get('SH004')!.endMs).toBe(slower.totalDurationMs);
    expect(after.shots.get('SH002')!.startMs).toBeGreaterThan(before.shots.get('SH002')!.startMs);
    expect(tiles([...after.shots.values()], slower.totalDurationMs)).toBe(true);
  });

  it('reports a shot whose anchor is not a cut point of the narration it is timed on', () => {
    const { facts, script } = history();
    const draft = sketchDraft(facts, [{ to: '1.2:end', shots: [{ to: '1.2:9' }, {}] }, { to: '⟨end⟩' }]);
    const untimed = buildSpine(syntheticSpine(script, { untimed: ['1.2:9'] }), script);
    const t = timeStoryboard(draft, untimed);
    expect(t.missing.get('SH001')).toBe('the cut point 1.2:9 is not in the narration');
    expect(t.missing.get('SH002')).toBe('the cut point 1.2:9 is not in the narration');
  });
});
