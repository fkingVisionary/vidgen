import { createHash } from 'node:crypto';
import type { AssetRequirement, ContinuitySpec, ScriptBlockClass, ShotClaimRole, ShotSpec, ShotSubjectDetail, VisualBeatContent, VisualTreatment, ProductionMethod } from '@docengine/core';

/**
 * Content hashes (§2.12): sha256 of canonical JSON (keys sorted), with no
 * times, row ids or costs in them. A shot keeps its key across versions; an
 * equal key and hash (and a duration close to the old one) means a person's
 * decision on it still applies to what they saw.
 */

/** JSON with object keys sorted at every level; undefined values left out. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface ShotHashInput {
  beatKey: string;
  treatment: VisualTreatment | null;
  method: ProductionMethod | null;
  infoClass: ScriptBlockClass | null;
  spec: ShotSpec;
  asset: AssetRequirement | null;
  claims: readonly { claimId: string; role: ShotClaimRole }[];
  subjects: readonly { subjectKey: string; detail: ShotSubjectDetail }[];
  anchors: { narration: { from: string; to: string } | null; silenceAt: string | null; visualFrom: string | null; visualTo: string | null; cutIn: string; cutOut: string };
}

/**
 * The asset requirement without its length (ms), the provider and model the
 * cost recommended, or the earlier shot whose asset it reuses: which shot
 * makes a shared asset follows from the rest of the version, not from this
 * shot's content.
 */
function assetContent(a: AssetRequirement | null) {
  if (!a) return null;
  const { durationSec: _d, reuseOf: _r, reuse, ...rest } = a;
  const { provider: _p, model: _m, ...keep } = reuse;
  return { ...rest, reuse: keep };
}

export function shotHash(s: ShotHashInput): string {
  return sha256(
    canonical({
      beatKey: s.beatKey,
      treatment: s.treatment,
      method: s.method,
      infoClass: s.infoClass,
      spec: s.spec,
      asset: assetContent(s.asset),
      claims: s.claims.map((c) => `${c.claimId}\u0000${c.role}`).sort(byText),
      subjects: [...s.subjects].sort((a, b) => byText(a.subjectKey, b.subjectKey)).map((x) => [x.subjectKey, x.detail]),
      anchors: s.anchors,
    }),
  );
}

export function beatHash(b: { key: string; content: VisualBeatContent; archBeatIds: readonly string[]; treatment: VisualTreatment; infoClass: ScriptBlockClass; claimIds: readonly string[] }): string {
  return sha256(canonical({ key: b.key, content: b.content, archBeatIds: b.archBeatIds, treatment: b.treatment, infoClass: b.infoClass, claims: [...b.claimIds].sort(byText) }));
}

export function subjectHash(key: string, spec: ContinuitySpec): string {
  return sha256(canonical({ key, spec }));
}
