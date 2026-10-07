import { SCOPE_END, SCOPE_START } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import type { StoryboardDraft } from './draft.ts';
import { resolveBeats, resolveShots } from './normalize.ts';
import { planStoryboard } from './plan.ts';
import { beatsPrompt, blockBrief, clock, markedText, repairPrompt, shotsPrompt } from './render.ts';
import { cutPointsIn, domainFilm, fakeBeats, fakeShot } from './testing.ts';

/**
 * The planning calls' briefs: the narration's words with the cut points
 * between them in clock order (never beside an untimed word), each block's
 * class, beats, claims with verdict and presentation, the treatments its
 * class allows and its obligations; a shots brief names only its own
 * beats; a repair brief carries what the checks found. A brief made from
 * the facts is enough to plan from: a plan of its cut points resolves with
 * nothing dropped.
 */

describe('the planning briefs', () => {
  it('mark every cut point between the words, in clock order, from the start of the scope to its end', () => {
    const { facts } = domainFilm('history');
    const prompt = beatsPrompt(facts, { title: 'Corvel (test)' });
    const ids = cutPointsIn(prompt);
    expect(ids[0]).toBe(SCOPE_START);
    expect(ids.at(-1)).toBe(SCOPE_END);
    const positions = ids.map((id) => facts.spine.point(id)!.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(ids)).toEqual(new Set(facts.spine.points.map((p) => p.id)));
    // A brief is enough to plan from: the beats of its cut points resolve with nothing dropped.
    const notes: string[] = [];
    const { beats } = resolveBeats(fakeBeats(prompt), facts, notes);
    expect(notes).toEqual([]);
    expect(beats.map((b) => b.narration.to)).toEqual(facts.spine.blocks.map((b) => facts.spine.at(b.last + 1)!.id));
  });

  it('never offers a cut beside a word the narration did not time, and says which words are untimed', () => {
    const { facts } = domainFilm('history', { untimed: ['1.2:3'] });
    const b = facts.spine.block('1.2')!;
    const text = markedText(facts, b);
    expect(text).toMatch(/fire° /);
    expect(text).not.toMatch(/⟦1\.2:3 /);
    expect(text).not.toMatch(/⟦1\.2:4 /);
  });

  it('give each block its class, beats, claims with verdict and presentation, the treatments it allows and its obligations', () => {
    const { facts } = domainFilm('history');
    const brief = blockBrief(facts, facts.spine.block('2.1')!);
    expect(brief).toMatch(/^### Block 2\.1 · UNCERTAIN · \d:\d\d\.\d–\d:\d\d\.\d \(\d+\.\d s\)/);
    expect(brief).toMatch(/Architecture beats: 2\.1 REVEAL \(UNCERTAIN; cast R1\)/);
    expect(brief).toMatch(/- H2 \(PROBABLE, \w+ confidence; present as HEDGE: [^)]*\)?.*: The harbourmaster Elias Brandt probably ordered the warehouses opened\./);
    expect(brief).toMatch(/Treatments allowed over UNCERTAIN words: [A-Z_, ]*CINEMATIC_RECONSTRUCTION/);
    expect(brief).not.toMatch(/FICTION/);
    const mira = blockBrief(facts, facts.spine.block('1.3')!);
    expect(mira).toMatch(/· fictional device/);
    expect(mira).toMatch(/Label obligation: the script promised an on-screen label/);
    expect(clock(61_250)).toBe('1:01.3');
  });

  it('a shots brief names only the beats it plans, and carries the editor\'s instructions and the current shots of a re-plan', () => {
    const { facts } = domainFilm('investigation');
    const notes: string[] = [];
    const { beats, subjects } = resolveBeats(fakeBeats(beatsPrompt(facts, { title: 'Aster (test)' })), facts, notes);
    const section = beats.slice(1, 3);
    const prompt = shotsPrompt(facts, { title: 'Aster (test)', beats: section, subjects, approach: 'B', instructions: 'Show the inquiry report (test).', current: [] });
    expect([...new Set([...prompt.matchAll(/\bVB\d+\b/g)].map((m) => m[0]))]).toEqual(section.map((b) => b.key));
    expect(prompt).toMatch(/## The beats to plan \(approach B: Evidence-led\)/);
    expect(prompt).toMatch(/## The editor's instructions\nShow the inquiry report \(test\)\./);
    // Only the narration those beats cover.
    expect(prompt).not.toMatch(/### Block 1\.1 /);
  });

  it('give the period and place of the story candidates behind the sections planned, as era context and never a claim', () => {
    const { facts } = domainFilm('history');
    const sequences = [...new Set(facts.spine.blocks.map((b) => b.sequence))];
    expect(sequences.length).toBeGreaterThan(1);
    const [first, second] = sequences as [number, number];
    // The architecture's sequences name the candidates they were built from.
    facts.scope.sequences.get(first)!.candidateIds.push('cand-1');
    facts.scope.sequences.get(second)!.candidateIds.push('cand-2');
    const candidates = [
      { id: 'cand-1', key: 'C01', timePeriod: 'Late summer, 1771', setting: 'A harbour town (test)', visualEnvironment: 'Warehouses along a stone quay (test)' },
      { id: 'cand-2', key: 'C02', timePeriod: 'The following winter', setting: 'The town court (test)', visualEnvironment: null },
      { id: 'cand-9', key: 'C09', timePeriod: '1802', setting: 'Nowhere this film goes (test)', visualEnvironment: null },
    ];
    const plain = beatsPrompt(facts, { title: 'Corvel (test)' });
    const prompt = beatsPrompt(facts, { title: 'Corvel (test)', candidates });
    expect(prompt).toMatch(new RegExp(`## Period and place \\(the story candidates these sections tell: era context for the look, never a claim to depict\\)\\n- section ${first}: C01 — Late summer, 1771; A harbour town \\(test\\); on screen: Warehouses along a stone quay \\(test\\)\\n- section ${second}: C02 — The following winter; The town court \\(test\\)\\n`));
    expect(prompt).not.toMatch(/C09/);
    expect(plain).not.toMatch(/## Period and place/);
    expect(cutPointsIn(prompt)).toEqual(cutPointsIn(plain));
    // A shots brief carries only the era of the sections its beats are in.
    const notes: string[] = [];
    const { beats, subjects } = resolveBeats(fakeBeats(plain), facts, notes);
    const own = beats.filter((b) => facts.spine.block(facts.spine.words[facts.spine.point(b.narration.from)!.position]!.blockKey)!.sequence === second);
    const shots = shotsPrompt(facts, { title: 'Corvel (test)', beats: own, subjects, approach: 'C', candidates });
    expect(shots).toMatch(/- section \d+: C02 — /);
    expect(shots).not.toMatch(/C01 — /);
  });

  it('a repair brief gives each beat its shots as they are and the blocking findings that name it', () => {
    const { facts } = domainFilm('history');
    const notes: string[] = [];
    const { beats, subjects } = resolveBeats(fakeBeats(beatsPrompt(facts, { title: 'Corvel (test)' })), facts, notes);
    const draft: StoryboardDraft = { approach: 'C', beats, shots: [], subjects, normalization: notes };
    const shots = resolveShots(beats.map((b) => fakeShot(b.key, b.narration, b.key === 'VB02' ? { treatment: 'ARCHIVAL_IMAGE', method: null, claims: [{ claimKey: 'H1', role: 'DEPICTS' }] } : {})), beats, draft, facts, notes).shots;
    const planned = planStoryboard({ ...draft, shots }, facts);
    const prompt = repairPrompt(facts, { title: 'Corvel (test)', beats: beats.filter((b) => b.key === 'VB02'), shots, subjects, approach: 'C', findings: planned.qa, partition: [] });
    expect(prompt).toMatch(/^## VB02 "[^"]*" \S+ → \S+ \(ENVIRONMENT\)$/m);
    expect(prompt).toMatch(/Shots now:\n- \{"key":"SH002"/);
    expect(prompt).toMatch(/# Task\nReturn replacement shots for VB02/);
  });
});
