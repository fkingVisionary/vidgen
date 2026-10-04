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

export interface FigureCheck {
  /** Figures found nowhere in the dossier (or years absent from it). */
  unsupported: string[];
  /** Figures in the dossier but not in the cited evidence, with the claims to link. */
  links: { figure: string; claimKeys: string[] }[];
}

/**
 * Every figure in `texts` must come from the evidence of `claimKeys`. Years
 * only need to appear somewhere in the dossier. A figure that appears in
 * other claims gets those claims linked (traceability); one that appears
 * nowhere is unsupported.
 */
export function checkFigures(texts: readonly string[], claimKeys: readonly string[], evidence: EvidenceBase): FigureCheck {
  const cited = evidence.figuresFor(claimKeys);
  const unsupported: string[] = [];
  const links: FigureCheck['links'] = [];
  // Candidate and claim keys (S10, C014) are references, not figures.
  for (const figure of extractFigures(texts.join('\n').replace(/\b[CSM]\d{2,4}\b/g, ' '))) {
    if (isYear(figure)) {
      if (!evidence.inDossier(figure)) unsupported.push(figure);
      continue;
    }
    if (cited.has(figure)) continue;
    const others = strongestFirst(evidence, evidence.claimsWithFigure(figure)).slice(0, MAX_AUTO_LINKS);
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

/** Is a named person in the evidence of these claims, or elsewhere in the dossier (then link where)? */
export function checkPerson(name: string, claimKeys: readonly string[], evidence: EvidenceBase): PersonCheck {
  if (nameGrounded(name, new WordIndex(evidence.textFor(claimKeys)))) return { grounded: true, link: [] };
  const mentioning = evidence.claimsMentioning(nameTokens(name));
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
