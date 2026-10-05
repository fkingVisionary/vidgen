import { DEFAULT_DELIVERY, DELIVERY_EMOTIONS, DELIVERY_ENERGIES, DELIVERY_MARKS, DELIVERY_PACES, type ScriptDelivery } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { deliveryMark, directionLeaks } from './layers.ts';

/**
 * Semantic layers (Parts XIV and XV): the narration is only what the narrator
 * says. A bracketed direction, a markup tag, a production label, a stage
 * direction in parentheses, an edit instruction or a claim key inside it
 * would be read aloud — or taken by a voice model as a performance tag — so
 * each is caught. Ordinary narration, asides included, is left alone. The
 * delivery mark is what an editor would write beside a block: most blocks
 * are an ordinary read and get none.
 */

type Delivery = Pick<ScriptDelivery, 'pace' | 'energy' | 'emotion'>;
const ORDINARY: Delivery = { pace: 'NORMAL', energy: 'MEDIUM', emotion: 'NEUTRAL' };
const read = (d: Partial<Delivery>) => deliveryMark({ ...ORDINARY, ...d });

// ── directionLeaks ───────────────────────────────────────────────────────────

describe('directionLeaks: production metadata inside the narration', () => {
  it('finds nothing in clean narration', () => {
    expect(directionLeaks('In February 1637 an auction at Alkmaar raised 90,000 guilders.')).toEqual([]);
    expect(directionLeaks('Cornelis Proefman agreed to pay 1,200 guilders for a single bulb, about four years of a skilled craftsman’s wages.')).toEqual([]);
  });

  it('catches a bracketed direction such as [pause], which a voice model would perform', () => {
    expect(directionLeaks('The price doubled. [pause] Then it doubled again.')).toEqual(['a bracketed direction ("[pause]")']);
    expect(directionLeaks('[whispers] Nobody paid.')).toEqual(['a bracketed direction ("[whispers]")']);
  });

  it('catches a long bracketed direction too, clipped in the report', () => {
    const long = '[pauses, then goes on more quietly, almost to himself]';
    expect(long.length).toBeGreaterThan(42);
    expect(directionLeaks(`The price doubled. ${long} Nobody paid.`)).toEqual([`a bracketed direction ("${long.slice(0, 40)}")`]);
  });

  it('catches markup such as an SSML <break/> tag', () => {
    expect(directionLeaks('The price doubled. <break time="1.5s"/> Then it doubled again.')).toEqual(['a markup tag ("<break time="1.5s"/>")']);
    expect(directionLeaks('It was <emphasis>never</emphasis> paid.')).toEqual(['a markup tag ("<emphasis>")']);
  });

  it('catches production labels written in capitals: VISUAL:, SFX:, NARRATOR:, NOTE:', () => {
    expect(directionLeaks('VISUAL: a ledger, the ink still wet. The sale was recorded on the third.')).toEqual(['a production label ("VISUAL:")']);
    expect(directionLeaks('SFX: auction bell. The bidding opened at noon.')).toEqual(['a production label ("SFX:")']);
    expect(directionLeaks('NARRATOR: The bidding opened at noon.')).toEqual(['a production label ("NARRATOR:")']);
    expect(directionLeaks('The bidding opened at noon. NOTE: check the date.')).toEqual(['a production label ("NOTE:")']);
  });

  it('catches every production label, with or without a space before the colon', () => {
    for (const label of ['MUSIC:', 'ON SCREEN:', 'ON-SCREEN:', 'CAPTION:', 'V.O.:', 'VO:', 'EDITOR:', 'DELIVERY:', 'PAUSE:', 'BEAT:', 'VISUAL :']) {
      expect(directionLeaks(`${label} The bidding opened at noon.`), label).toEqual([`a production label ("${label}")`]);
    }
  });

  it('catches a stage direction in parentheses such as (pause) or (softly)', () => {
    expect(directionLeaks('The price doubled. (pause) Then it doubled again.')).toEqual(['a stage direction in parentheses ("(pause)")']);
    expect(directionLeaks('(softly) Nobody paid.')).toEqual(['a stage direction in parentheses ("(softly)")']);
    expect(directionLeaks('Nobody paid. (Music swells.)')).toEqual(['a stage direction in parentheses ("(Music swells.)")']);
  });

  it('catches an edit instruction such as CUT TO or FADE OUT', () => {
    expect(directionLeaks('CUT TO the auction room in Alkmaar.')).toEqual(['an edit instruction ("CUT TO")']);
    expect(directionLeaks('The last bulb was sold. FADE OUT.')).toEqual(['an edit instruction ("FADE OUT")']);
    expect(directionLeaks('FADE IN on the harbour at Enkhuizen.')).toEqual(['an edit instruction ("FADE IN")']);
    expect(directionLeaks('The last bulb was sold. FADE TO black.')).toEqual(['an edit instruction ("FADE TO")']);
  });

  it('catches a claim key, which belongs in the evidence layer', () => {
    expect(directionLeaks('One bulb was reportedly offered for 5,500 guilders (C009).')).toEqual(['a claim key ("C009")']);
    expect(directionLeaks('Proefman agreed to pay C008 1,200 guilders.')).toEqual(['a claim key ("C008")']);
  });

  it('leaves ordinary parentheses alone: an aside is narration, not a direction', () => {
    expect(directionLeaks('The test (the first of three) was held in Haarlem.')).toEqual([]);
    expect(directionLeaks('Some buyers (test)')).toEqual([]);
    expect(directionLeaks('A craftsman earned roughly 300 guilders (about a guilder a working day).')).toEqual([]);
  });

  it('leaves ordinary words alone: a lower-case "cut to", a sentence that starts "Note", a year, a colon', () => {
    expect(directionLeaks('The council cut to the bone what it paid the clerks.')).toEqual([]);
    expect(directionLeaks('Within a year the fashion began to fade out of the taverns.')).toEqual([]);
    expect(directionLeaks('Few visual records survive: no painter drew the auction, and no music was written for it.')).toEqual([]);
    expect(directionLeaks('Note the date on the contract: the third of February.')).toEqual([]);
    expect(directionLeaks('By 1637 the visual arts of Haarlem were famous: painters bought bulbs too.')).toEqual([]);
    expect(directionLeaks('The C-major chord in bar 12 was copied by hand.')).toEqual([]);
    // Inside a quotation the words are the record's: an editorial elision or "[sic]" is not a direction.
    expect(directionLeaks('One buyer wrote that "a single bulb [...] fetched more than a house".')).toEqual([]);
    expect(directionLeaks('The clerk wrote “We [the growers] were ruin’d [sic]” and signed it.')).toEqual([]);
  });

  it('reports each kind of leak once, in a stable order, however often it occurs', () => {
    const leaks = directionLeaks('[pause] VISUAL: the ledger. [beat] The sale (C003) was final. <break time="1s"/> CUT TO the street.');
    expect(leaks).toEqual([
      'a bracketed direction ("[pause]")',
      'a markup tag ("<break time="1s"/>")',
      'a production label ("VISUAL:")',
      'an edit instruction ("CUT TO")',
      'a claim key ("C003")',
    ]);
  });

  it('clips a long excerpt to forty characters', () => {
    const [leak] = directionLeaks('Nobody paid. (slowly, as if the narrator were remembering a very long winter in Haarlem)');
    expect(leak).toBe('a stage direction in parentheses ("(slowly, as if the narrator were remembe")');
    expect('(slowly, as if the narrator were remembe').toHaveLength(40);
  });
});

// ── deliveryMark ─────────────────────────────────────────────────────────────

describe('deliveryMark: the mark an editor writes beside a block', () => {
  it('gives an ordinary read no mark at all', () => {
    expect(deliveryMark(ORDINARY)).toBeNull();
  });

  it('marks a curious delivery [curious]', () => {
    expect(read({ emotion: 'CURIOUS' })).toBe('curious');
  });

  it('marks a reflective or a sombre delivery [reflective]', () => {
    expect(read({ emotion: 'REFLECTIVE' })).toBe('reflective');
    expect(read({ emotion: 'SOMBER' })).toBe('reflective');
  });

  it('marks a fast, high-energy delivery, or a fast tense one, [urgent]', () => {
    expect(read({ pace: 'FAST', energy: 'HIGH' })).toBe('urgent');
    expect(read({ pace: 'FAST', emotion: 'TENSE' })).toBe('urgent');
  });

  it('marks a low-energy delivery [quiet]', () => {
    expect(read({ energy: 'LOW' })).toBe('quiet');
    expect(read({ energy: 'LOW', pace: 'SLOW' })).toBe('quiet');
    // Fast but low, and neither high-energy nor tense: still quiet, not urgent.
    expect(read({ energy: 'LOW', pace: 'FAST' })).toBe('quiet');
    expect(read({ energy: 'LOW', emotion: 'EXCITED' })).toBe('quiet');
  });

  it('marks a slow delivery [measured]', () => {
    expect(read({ pace: 'SLOW' })).toBe('measured');
    expect(read({ pace: 'SLOW', energy: 'HIGH' })).toBe('measured');
  });

  it('leaves a change that is not one of the five marks unmarked', () => {
    expect(read({ pace: 'FAST' })).toBeNull();
    expect(read({ energy: 'HIGH' })).toBeNull();
    expect(read({ emotion: 'TENSE' })).toBeNull();
    expect(read({ emotion: 'EXCITED' })).toBeNull();
    expect(read({ emotion: 'NEUTRAL', pace: 'NORMAL', energy: 'MEDIUM' })).toBeNull();
  });

  it('lets the emotion decide first: a curious or reflective block keeps its mark whatever its pace and energy', () => {
    expect(read({ emotion: 'CURIOUS', pace: 'FAST', energy: 'HIGH' })).toBe('curious');
    expect(read({ emotion: 'CURIOUS', energy: 'LOW' })).toBe('curious');
    expect(read({ emotion: 'SOMBER', pace: 'FAST', energy: 'HIGH' })).toBe('reflective');
    expect(read({ emotion: 'REFLECTIVE', pace: 'SLOW' })).toBe('reflective');
  });

  it('prefers [urgent] to [quiet] for a fast tense block read softly', () => {
    expect(read({ emotion: 'TENSE', pace: 'FAST', energy: 'LOW' })).toBe('urgent');
  });

  it('gives every possible delivery one of the five marks or none — and exactly these', () => {
    const all = DELIVERY_PACES.flatMap((pace) => DELIVERY_ENERGIES.flatMap((energy) => DELIVERY_EMOTIONS.map((emotion) => ({ pace, energy, emotion }))));
    expect(all).toHaveLength(54);
    const tally: Record<string, string[]> = {};
    for (const d of all) {
      const mark = deliveryMark(d);
      expect(mark === null || DELIVERY_MARKS.includes(mark)).toBe(true);
      (tally[mark ?? 'none'] ??= []).push(`${d.pace} ${d.energy} ${d.emotion}`);
    }
    // Every curious, reflective or sombre delivery is marked by its emotion, whatever its pace and energy.
    expect(tally.curious).toHaveLength(9);
    expect(tally.reflective).toHaveLength(18);
    expect(tally.urgent).toEqual(['FAST LOW TENSE', 'FAST MEDIUM TENSE', 'FAST HIGH NEUTRAL', 'FAST HIGH TENSE', 'FAST HIGH EXCITED']);
    expect(tally.quiet).toEqual(['SLOW LOW NEUTRAL', 'SLOW LOW TENSE', 'SLOW LOW EXCITED', 'NORMAL LOW NEUTRAL', 'NORMAL LOW TENSE', 'NORMAL LOW EXCITED', 'FAST LOW NEUTRAL', 'FAST LOW EXCITED']);
    expect(tally.measured).toEqual(['SLOW MEDIUM NEUTRAL', 'SLOW MEDIUM TENSE', 'SLOW MEDIUM EXCITED', 'SLOW HIGH NEUTRAL', 'SLOW HIGH TENSE', 'SLOW HIGH EXCITED']);
    expect(tally.none).toEqual(['NORMAL MEDIUM NEUTRAL', 'NORMAL MEDIUM TENSE', 'NORMAL MEDIUM EXCITED', 'NORMAL HIGH NEUTRAL', 'NORMAL HIGH TENSE', 'NORMAL HIGH EXCITED', 'FAST MEDIUM NEUTRAL', 'FAST MEDIUM EXCITED']);
  });

  it('reads only pace, energy and emotion: emphasis and pauses do not change the mark', () => {
    const slow: ScriptDelivery = { ...DEFAULT_DELIVERY, pace: 'SLOW' };
    const slowWithPauses: ScriptDelivery = { ...slow, emphasis: [{ text: 'guilders', level: 'STRONG' }], pauseBefore: { length: 'LONG', reason: 'REVEAL' }, pauseAfter: { length: 'MEDIUM', reason: 'NUMBER' } };
    const ordinaryWithPause: ScriptDelivery = { ...DEFAULT_DELIVERY, pauseBefore: { length: 'LONG', reason: 'EMOTIONAL_TURN' } };
    expect(deliveryMark(slow)).toBe('measured');
    expect(deliveryMark(slowWithPauses)).toBe('measured');
    expect(deliveryMark(DEFAULT_DELIVERY)).toBeNull();
    expect(deliveryMark(ordinaryWithPause)).toBeNull();
  });
});
