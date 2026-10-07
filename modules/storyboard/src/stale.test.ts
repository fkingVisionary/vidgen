import { describe, expect, it } from 'vitest';
import { planStoryboard } from './plan.ts';
import { narrationApprovalOf, staleFindings, type LiveFacts, type PinnedFacts } from './stale.ts';
import { domainFilm, sketchDraft } from './testing.ts';

/**
 * Approval is version-specific (§2.13): each STALE_* kind from one changed
 * input, derived from what a version pinned and what is true now, and the
 * narration's approval level.
 */

const { facts } = domainFilm('history');
const planned = planStoryboard(
  sketchDraft(facts, [
    { to: '1.2:end', treatment: 'CINEMATIC_RECONSTRUCTION', shots: [{ claims: [{ claimKey: 'H1', role: 'DEPICTS' }] }] },
    { to: '2.1:end', treatment: 'TEXT_ON_SCREEN', shots: [{ claims: [{ claimKey: 'H5', role: 'CONTEXT' }, { claimKey: 'H2', role: 'CONTEXT' }] }] },
    { to: '⟨end⟩' },
  ]),
  facts,
);
const pinned: PinnedFacts = {
  scriptId: 'script-1',
  storyId: 'arch-1',
  voiceAssemblyId: 'assembly-1',
  fingerprint: facts.spine.narration.assembly.fingerprint,
  takes: facts.spine.narration.takes.map((t) => ({ id: t.id })),
  profile: { profileId: 'profile-1', overrides: { density: 'SPARSE' } },
  catalogVersion: 'test-catalog.1',
  shots: planned.shots.map((s) => ({ key: s.key, evidence: s.evidence })),
};
const live = (o: Partial<LiveFacts> = {}): LiveFacts => ({
  approvedScriptId: 'script-1',
  scriptStatus: 'APPROVED',
  architectureStatus: 'APPROVED',
  latestFingerprint: pinned.fingerprint,
  pinnedAssemblyStatus: 'IN_REVIEW',
  gateAssemblyId: null,
  takeStatuses: new Map(pinned.takes.map((t) => [t.id, 'APPROVED'])),
  verdicts: new Map(planned.shots.flatMap((s) => s.evidence?.claims.map((c) => [c.claimId, c.verdict] as const) ?? [])),
  profile: { profileId: 'profile-1', overrides: { density: 'SPARSE' } },
  catalogVersion: 'test-catalog.1',
  ...o,
});
const stale = (o: Partial<LiveFacts>, gate = false) => staleFindings(pinned, live(o), { gate }).map((f) => `${f.severity} ${f.kind} ${f.ref ?? '-'}: ${f.detail}`);

describe('stale findings, derived on read', () => {
  it('finds nothing when nothing changed', () => {
    expect(stale({})).toEqual([]);
  });

  it('STALE_SCRIPT and STALE_ARCHITECTURE', () => {
    expect(stale({ approvedScriptId: 'script-2' })).toEqual(['BLOCKING STALE_SCRIPT -: Another script version is now the approved one']);
    expect(stale({ scriptStatus: 'SUPERSEDED' })).toEqual(['BLOCKING STALE_SCRIPT -: The script it was planned from is superseded']);
    expect(stale({ architectureStatus: 'SUPERSEDED' })).toEqual(['BLOCKING STALE_ARCHITECTURE -: The architecture its script tells is superseded']);
  });

  it('STALE_NARRATION: other clips, a superseded assembly, a rejected take — and at the gate, another approved assembly', () => {
    expect(stale({ latestFingerprint: 'f'.repeat(64) })).toEqual(['BLOCKING STALE_NARRATION -: the narration it is timed against has changed (a take regenerated or restored): re-time it']);
    expect(stale({ pinnedAssemblyStatus: 'SUPERSEDED' })).toEqual(['BLOCKING STALE_NARRATION -: its assembly is superseded']);
    expect(stale({ takeStatuses: new Map([[pinned.takes[2]!.id, 'REJECTED']]) })).toEqual(['BLOCKING STALE_NARRATION -: 1 take it is timed against is now rejected']);
    expect(stale({ gateAssemblyId: 'assembly-9' })).toEqual([]);
    expect(stale({ gateAssemblyId: 'assembly-9' }, true)).toEqual(['BLOCKING STALE_NARRATION -: the approved narration is another assembly']);
  });

  it('STALE_VERDICT: blocking when a depicted claim now needs another presentation; a warning for context, or the same presentation', () => {
    const verdicts = (over: Record<string, 'ESTABLISHED' | 'PROBABLE' | 'DISPUTED' | 'MYTH'>) => new Map([...live().verdicts, ...Object.entries(over)]);
    expect(stale({ verdicts: verdicts({ 'claim-H1': 'DISPUTED' }) })).toEqual(['BLOCKING STALE_VERDICT SH001: H1 is now DISPUTED (was ESTABLISHED): it must be presented as PRESENT_AS_DISPUTED']);
    expect(stale({ verdicts: verdicts({ 'claim-H5': 'PROBABLE' }) })).toEqual(['WARNING STALE_VERDICT SH002: H5 is now PROBABLE (was ESTABLISHED)']);
    expect(stale({ verdicts: verdicts({ 'claim-H2': 'ESTABLISHED' }) })).toEqual(['WARNING STALE_VERDICT SH002: H2 is now ESTABLISHED (was PROBABLE)']);
  });

  it('STALE_PROFILE and STALE_PRICING are warnings: the frozen figures stay', () => {
    expect(stale({ profile: { profileId: 'profile-2', overrides: { density: 'SPARSE' } } })).toEqual(['WARNING STALE_PROFILE -: The project now resolves to another visual profile version, or its overrides changed']);
    expect(stale({ profile: { profileId: 'profile-1', overrides: {} } })).toHaveLength(1);
    expect(stale({ catalogVersion: 'test-catalog.2' })).toEqual(['WARNING STALE_PRICING -: The visual catalog changed (test-catalog.1 → test-catalog.2); the frozen estimates stay']);
  });
});

describe('how far the narration is approved', () => {
  it('is gate-approved, takes-approved, or unreviewed', () => {
    expect(narrationApprovalOf({ assemblyId: 'a1', assemblyStatus: 'APPROVED', gateAssemblyId: 'a1', takeStatuses: ['IN_REVIEW'] })).toBe('GATE_APPROVED');
    expect(narrationApprovalOf({ assemblyId: 'a1', assemblyStatus: 'APPROVED', gateAssemblyId: 'a0', takeStatuses: ['APPROVED', 'APPROVED'] })).toBe('TAKES_APPROVED');
    expect(narrationApprovalOf({ assemblyId: 'a1', assemblyStatus: 'IN_REVIEW', gateAssemblyId: null, takeStatuses: ['APPROVED', 'IN_REVIEW'] })).toBe('UNREVIEWED');
    expect(narrationApprovalOf({ assemblyId: 'a1', assemblyStatus: 'IN_REVIEW', gateAssemblyId: null, takeStatuses: [] })).toBe('UNREVIEWED');
  });
});
