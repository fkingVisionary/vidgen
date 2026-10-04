import { CAVEAT_VERDICTS, type ClaimImportance, type ClaimVerdict } from '@docengine/core';
import type { EvidenceBase } from './evidence.ts';
import { WordIndex, extractFigures, isYear, nameGrounded, nameTokens } from './text.ts';

/**
 * The evidence rules shared by mining, architecture and both quality gates.
 * Normalization uses them to repair what can be repaired (linking the claim a
 * figure or person comes from) and to remove what cannot; the gates run them
 * again on the final result.
 */

const IMPORTANCE_ORDER: Record<ClaimImportance, number> = { KEY: 0, SUPPORTING: 1, BACKGROUND: 2 };
const VERDICT_ORDER: Record<ClaimVerdict, number> = { ESTABLISHED: 0, PROBABLE: 1, DISPUTED: 2, MYTH: 3, UNVERIFIED: 4 };

/**
 * Claim keys, best to link first: firmer verdicts (so a myth or dispute is
 * only pulled into a story when nothing firmer has the fact), then key claims.
 */
function strongestFirst(evidence: EvidenceBase, keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ca = evidence.claim(a)!;
    const cb = evidence.claim(b)!;
    return VERDICT_ORDER[ca.verdict] - VERDICT_ORDER[cb.verdict] || IMPORTANCE_ORDER[ca.importance] - IMPORTANCE_ORDER[cb.importance];
  });
}

/** Claims linked automatically for one figure or person: the single best source of it. */
export const MAX_AUTO_LINKS = 1;

/** Where evidence for a figure or person may come from. */
export interface EvidenceScope {
  /** Claims a figure or person missing from the cited evidence may be linked from (default: the whole dossier). */
  linkFrom?: readonly string[];
  /** Years must also come from the cited or linkable evidence, not merely appear somewhere in the dossier. */
  strictYears?: boolean;
}

export interface FigureCheck {
  /** Figures not found in the allowed evidence (by default: nowhere in the dossier; years: absent from it). */
  unsupported: string[];
  /** Figures in the allowed evidence but not in the cited claims, with the claims to link. */
  links: { figure: string; claimKeys: string[] }[];
}

/**
 * Every figure in `texts` must come from the evidence of `claimKeys`. By
 * default years only need to appear somewhere in the dossier, and a figure
 * found in another claim gets that claim linked (traceability); `scope`
 * narrows both. A figure found nowhere allowed is unsupported.
 */
export function checkFigures(texts: readonly string[], claimKeys: readonly string[], evidence: EvidenceBase, scope: EvidenceScope = {}): FigureCheck {
  const cited = evidence.figuresFor(claimKeys);
  const allowed = scope.linkFrom ? new Set(scope.linkFrom) : null;
  const unsupported: string[] = [];
  const links: FigureCheck['links'] = [];
  // Candidate and claim keys (S10, C014) are references, not figures.
  for (const figure of extractFigures(texts.join('\n').replace(/\b[CSM]\d{2,4}\b/g, ' '))) {
    if (isYear(figure) && !scope.strictYears) {
      if (!evidence.inDossier(figure)) unsupported.push(figure);
      continue;
    }
    if (cited.has(figure)) continue;
    const from = evidence.claimsWithFigure(figure).filter((k) => !allowed || allowed.has(k));
    const others = strongestFirst(evidence, from).slice(0, MAX_AUTO_LINKS);
    if (others.length > 0) links.push({ figure, claimKeys: others });
    else unsupported.push(figure);
  }
  return { unsupported, links };
}

export interface PersonCheck {
  grounded: boolean;
  /** Claims to link: the person is in the dossier, but not in the cited evidence. */
  link: string[];
}

/** Is a named person in the evidence of these claims, or in other allowed claims (then link where)? */
export function checkPerson(name: string, claimKeys: readonly string[], evidence: EvidenceBase, scope: Pick<EvidenceScope, 'linkFrom'> = {}): PersonCheck {
  if (nameGrounded(name, new WordIndex(evidence.textFor(claimKeys)))) return { grounded: true, link: [] };
  const allowed = scope.linkFrom ? new Set(scope.linkFrom) : null;
  const mentioning = evidence.claimsMentioning(nameTokens(name)).filter((k) => !allowed || allowed.has(k));
  if (mentioning.length === 0) return { grounded: false, link: [] };
  return { grounded: true, link: strongestFirst(evidence, mentioning).slice(0, MAX_AUTO_LINKS) };
}

/** Claims used that must be told with a caveat (DISPUTED, UNVERIFIED, MYTH). */
export function caveatClaims(claimKeys: readonly string[], evidence: EvidenceBase): string[] {
  return claimKeys.filter((k) => {
    const c = evidence.claim(k);
    return c !== undefined && CAVEAT_VERDICTS.includes(c.verdict);
  });
}

/** Keys in dossier order, deduplicated, unknown keys dropped. */
export function orderedKeys(keys: Iterable<string>, evidence: EvidenceBase): string[] {
  const wanted = new Set(keys);
  return [...evidence.claims.keys()].filter((k) => wanted.has(k));
}
