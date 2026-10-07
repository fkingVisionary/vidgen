import {
  PRESENTATION_FOR_VERDICT,
  type ArtifactStatus,
  type ClaimVerdict,
  type NarrationApproval,
  type ShotEvidence,
  type StoryboardQaFinding,
  type VisualConfigOverrides,
  type VoiceGenerationStatus,
} from '@docengine/core';
import { canonical } from './hash.ts';

/**
 * Approval is version-specific, and a material change upstream makes it
 * stale (§2.13). Staleness is derived on read — in views, at decisions and
 * at the gate — from what a version pinned and what is true now; it is
 * never stored. This is the pure evaluation; the caller loads the live facts.
 */

/** What a version pinned when it was saved. */
export interface PinnedFacts {
  scriptId: string;
  /** The architecture the script told (null: not recorded). */
  storyId: string | null;
  voiceAssemblyId: string | null;
  fingerprint: string | null;
  takes: readonly { id: string }[];
  profile: { profileId: string; overrides: VisualConfigOverrides };
  catalogVersion: string;
  shots: readonly { key: string; evidence: ShotEvidence | null }[];
}

/** What is true now. */
export interface LiveFacts {
  /** The project's approved script now (null: none). */
  approvedScriptId: string | null;
  scriptStatus: ArtifactStatus | null;
  architectureStatus: ArtifactStatus | null;
  /** The fingerprint of the newest assembly of the pinned run. */
  latestFingerprint: string | null;
  pinnedAssemblyStatus: ArtifactStatus | null;
  /** The assembly the newest VOICE gate approval names (null: none). */
  gateAssemblyId: string | null;
  takeStatuses: ReadonlyMap<string, VoiceGenerationStatus>;
  /** Live verdicts by claim id. */
  verdicts: ReadonlyMap<string, ClaimVerdict>;
  /** What the project's visual selection resolves to now (null: nothing resolves). */
  profile: { profileId: string; overrides: VisualConfigOverrides } | null;
  catalogVersion: string;
}

const W = (kind: StoryboardQaFinding['kind'], severity: StoryboardQaFinding['severity'], ref: string | null, detail: string): StoryboardQaFinding => ({ kind, severity, ref, detail });

/** The STALE_* findings of a version now (the gate also requires its narration to be the gate-approved one). */
export function staleFindings(pinned: PinnedFacts, live: LiveFacts, o: { gate?: boolean } = {}): StoryboardQaFinding[] {
  const out: StoryboardQaFinding[] = [];
  if (live.approvedScriptId !== pinned.scriptId) out.push(W('STALE_SCRIPT', 'BLOCKING', null, live.approvedScriptId ? 'Another script version is now the approved one' : 'The project has no approved script now'));
  else if (live.scriptStatus !== 'APPROVED') out.push(W('STALE_SCRIPT', 'BLOCKING', null, `The script it was planned from is ${live.scriptStatus?.toLowerCase() ?? 'gone'}`));
  if (pinned.storyId && live.architectureStatus !== 'APPROVED') out.push(W('STALE_ARCHITECTURE', 'BLOCKING', null, `The architecture its script tells is ${live.architectureStatus?.toLowerCase() ?? 'gone'}`));

  const narration: string[] = [];
  if (pinned.fingerprint && live.latestFingerprint !== pinned.fingerprint) narration.push('the narration it is timed against has changed (a take regenerated or restored): re-time it');
  if (live.pinnedAssemblyStatus === 'SUPERSEDED' || live.pinnedAssemblyStatus === 'REJECTED') narration.push(`its assembly is ${live.pinnedAssemblyStatus.toLowerCase()}`);
  if (o.gate && live.gateAssemblyId !== pinned.voiceAssemblyId) narration.push('the approved narration is another assembly');
  const rejected = pinned.takes.filter((t) => live.takeStatuses.get(t.id) === 'REJECTED');
  if (rejected.length) narration.push(`${rejected.length} take${rejected.length === 1 ? ' it is' : 's it is'} timed against ${rejected.length === 1 ? 'is' : 'are'} now rejected`);
  if (narration.length) out.push(W('STALE_NARRATION', 'BLOCKING', null, narration.join('; ')));

  for (const s of pinned.shots) {
    for (const c of s.evidence?.claims ?? []) {
      const now = live.verdicts.get(c.claimId);
      if (!now || now === c.verdict) continue;
      const presentation = PRESENTATION_FOR_VERDICT[now];
      const factual = c.role === 'DEPICTS' || c.role === 'SHOWS_SOURCE' || c.role === 'DATA';
      const blocking = factual && presentation !== (c.presentation ?? 'STATE');
      out.push(W('STALE_VERDICT', blocking ? 'BLOCKING' : 'WARNING', s.key, `${c.claimKey} is now ${now} (was ${c.verdict})${blocking ? `: it must be presented as ${presentation}` : ''}`));
    }
  }
  if (!live.profile || live.profile.profileId !== pinned.profile.profileId || canonical(live.profile.overrides) !== canonical(pinned.profile.overrides)) {
    out.push(W('STALE_PROFILE', 'WARNING', null, 'The project now resolves to another visual profile version, or its overrides changed'));
  }
  if (live.catalogVersion !== pinned.catalogVersion) out.push(W('STALE_PRICING', 'WARNING', null, `The visual catalog changed (${pinned.catalogVersion} → ${live.catalogVersion}); the frozen estimates stay`));
  return out;
}

/**
 * How far the narration is approved (§2.2): its assembly is the one the
 * newest VOICE gate approval names and is APPROVED; or every take it uses is
 * APPROVED; or neither.
 */
export function narrationApprovalOf(o: { assemblyId: string; assemblyStatus: ArtifactStatus; gateAssemblyId: string | null; takeStatuses: readonly VoiceGenerationStatus[] }): NarrationApproval {
  if (o.assemblyStatus === 'APPROVED' && o.gateAssemblyId === o.assemblyId) return 'GATE_APPROVED';
  if (o.takeStatuses.length > 0 && o.takeStatuses.every((s) => s === 'APPROVED')) return 'TAKES_APPROVED';
  return 'UNREVIEWED';
}
