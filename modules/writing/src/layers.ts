import type { DeliveryMark, ScriptDelivery } from '@docengine/core';

/**
 * Semantic layers. A script block keeps five kinds of material apart:
 * NARRATION (the words spoken — nothing else ever reaches the voice),
 * VISUAL_DIRECTION (what the pictures carry), EDITORIAL_NOTE (why, for the
 * editor), DELIVERY_DIRECTION (how it is spoken) and EVIDENCE (the claims
 * behind it). Production metadata in the narration would be read aloud — or,
 * worse, taken by a voice model as a performance tag — so it is caught here.
 */

const LEAKS: { re: RegExp; what: string }[] = [
  // Any length: a long bracketed direction is still a tag to a voice model (the excerpt is clipped below).
  { re: /\[[^[\]]+\]/, what: 'a bracketed direction' },
  { re: /<\s*\/?\s*[a-z][^>]{0,40}>/i, what: 'a markup tag' },
  { re: /\b(?:VISUAL|SFX|MUSIC|ON[- ]SCREEN|CAPTION|NARRATOR|V\.O\.|VO|NOTE|EDITOR|DELIVERY|PAUSE|BEAT)\s*:/, what: 'a production label' },
  { re: /\((?:[^)]*\b(?:pause|beat|music|sfx|visual|cut to|fade|on screen|whisper(?:ed|s)?|softly|dramatic(?:ally)?|slowly|quietly|curious|reflective|urgent|measured)\b[^)]*)\)/i, what: 'a stage direction in parentheses' },
  { re: /\b(?:CUT TO|FADE (?:IN|OUT|TO))\b/, what: 'an edit instruction' },
  { re: /\bC\d{3}\b/, what: 'a claim key' },
];

/** Production metadata inside narration text (empty when the narration is clean). */
export function directionLeaks(text: string): string[] {
  return LEAKS.flatMap((l) => {
    const m = l.re.exec(text);
    return m ? [`${l.what} ("${m[0].slice(0, 40)}")`] : [];
  });
}

/**
 * The delivery mark an editor would write beside a block, read from its
 * provider-neutral delivery: [curious], [quiet], [measured], [urgent] or
 * [reflective] — or none for an ordinary read, which is most blocks.
 */
export function deliveryMark(d: Pick<ScriptDelivery, 'pace' | 'energy' | 'emotion'>): DeliveryMark | null {
  if (d.emotion === 'CURIOUS') return 'curious';
  if (d.emotion === 'REFLECTIVE' || d.emotion === 'SOMBER') return 'reflective';
  if ((d.pace === 'FAST' && d.energy === 'HIGH') || (d.emotion === 'TENSE' && d.pace === 'FAST')) return 'urgent';
  if (d.energy === 'LOW') return 'quiet';
  if (d.pace === 'SLOW') return 'measured';
  return null;
}

export interface LayeredBlock {
  key: string;
  narration: string;
  visual: { intent: string; note: string; mustShow: string[] } | null;
  delivery: { mark: DeliveryMark | null; pace: string; energy: string; emotion: string; pauses: string[] } | null;
  evidence: { claimKeys: string[]; presentation: string[] };
  editorial: string[];
  /** Production metadata found inside the narration (should be empty). */
  leaks: string[];
}
