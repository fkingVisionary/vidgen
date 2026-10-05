import type { DeliveryMark, ScriptDelivery } from '@docengine/core';
import { maskQuotes } from './text.ts';

/**
 * Semantic layers. A script block keeps five kinds of material apart:
 * NARRATION (the words spoken — nothing else ever reaches the voice),
 * VISUAL_DIRECTION (what the pictures carry), EDITORIAL_NOTE (why, for the
 * editor), DELIVERY_DIRECTION (how it is spoken) and EVIDENCE (the claims
 * behind it). Production metadata in the narration would be read aloud — or,
 * worse, taken by a voice model as a performance tag — so it is caught here.
 */

/** Words that direct a performance or an edit when they are all a parenthesis says. */
const CUE = String.raw`(?:pause|beat|silence|music|sfx|visual|fade(?: in| out)?|on[- ]screen|whisper(?:s|ed|ing)?|softly|gently|dramatic(?:ally)?|slowly|quietly|curious|reflective|urgent(?:ly)?|measured)`;

/**
 * A parenthesis that is a direction: a cue alone ("(pause)", "(long beat)",
 * "(Music swells.)"), a pause or a sound cue however it goes on ("(pause for
 * effect)", "(Music swells, then fades.)"), a label ("(SFX: a bell)"), a cut
 * between sentences ("Nobody paid. (cut to the harbour)"), or a manner that
 * speaks of the read ("(slowly, as if the narrator…)"). An aside that only
 * uses such a word is narration: "(slowly at first)", "(measured in
 * bushels)", "(a pause in the fighting)", "wages (cut to half)".
 */
const STAGE_DIRECTION = new RegExp(
  String.raw`\(\s*(?:(?:a |long |short |brief |slight |soft |another )?${CUE}(?:\s+(?:pause|beat|swells?|fades?|rises?|builds?|stops?|plays?|ends?|in|out|up|down|under|again))?[.!…]*|(?:long |short |brief |slight )?pause\b[^)]*|(?:sfx|music (?:swells?|fades?|rises?|builds?))\b[^)]*|(?:sfx|music|sound|visual|on[- ]screen|caption|narrator|vo|v\.o\.)\s*:[^)]*|(?:cut|fade) to (?:black|white)\b[^)]*|${CUE}\s*,[^)]*\b(?:narrator|narration|voice-?over)\b[^)]*)\s*\)|(?<=^|[.!?…]["”’)]?\s+)\(\s*(?:cut|fade) to\b[^)]*\)`,
  'i',
);

/** Keys cited the way a script cites them, alone in parentheses ("(C045)", "(C008, C009)"). */
const CITATION = /\(\s*C\d{3}(?:\s*[,;]\s*C\d{3})*\s*\)/g;

const LEAKS: { re: RegExp; what: string; raw?: true; claimKey?: true }[] = [
  // Any length: a long bracketed direction is still a tag to a voice model (the excerpt is clipped below).
  { re: /\[[^[\]]+\]/, what: 'a bracketed direction' },
  // Read on the raw text: a tag's attribute values are quoted (<break time="1s"/>).
  { re: /<\s*\/?\s*[a-z][^>]{0,40}>/i, what: 'a markup tag', raw: true },
  { re: /\b(?:VISUAL|SFX|MUSIC|ON[- ]SCREEN|CAPTION|NARRATOR|V\.O\.|VO|NOTE|EDITOR|DELIVERY|PAUSE|BEAT)\s*:/, what: 'a production label' },
  { re: STAGE_DIRECTION, what: 'a stage direction in parentheses' },
  { re: /\b(?:CUT TO|FADE (?:IN|OUT|TO))\b/, what: 'an edit instruction' },
  { re: /\bC\d{3}\b/g, what: 'a claim key', claimKey: true },
];

/**
 * Production metadata inside narration text (empty when the narration is
 * clean). Quotations are the record's words, not the narrator's: an editorial
 * "[…]" or "[sic]" inside one is not a direction. Given the claim keys the
 * script may cite, a "C" and three digits is a claim key only when it is one
 * of them or is cited like one ("(C045)") — otherwise it may be a model
 * number or a grid reference.
 */
export function directionLeaks(text: string, claimKeys?: ReadonlySet<string>): string[] {
  const own = maskQuotes(text);
  const cited = new Set([...own.matchAll(CITATION)].flatMap((c) => c[0].match(/C\d{3}/g) ?? []));
  const key = (k: string) => !claimKeys || claimKeys.has(k) || cited.has(k);
  return LEAKS.flatMap((l) => {
    const m = l.claimKey ? [...own.matchAll(l.re)].find((k) => key(k[0])) : l.re.exec(l.raw ? text : own);
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
