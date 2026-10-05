import { describe, expect, it } from 'vitest';
import { rhythmProfile, tongueTwister } from './rhythm.ts';
import type { NarrationBlock } from './text.ts';

/**
 * Spoken rhythm: how the narration moves when it is read aloud. The numbers
 * are signals for an editor, so they must be exact and explainable on a text
 * small enough to count by hand.
 */

const block = (key: string, text: string, extra: Partial<NarrationBlock> = {}): NarrationBlock => ({
  key,
  section: Number(key.split('.')[0]),
  text,
  infoClass: 'DOCUMENTED',
  speakerId: null,
  claimKeys: [],
  ...extra,
});

// ── A small text, counted by hand ────────────────────────────────────────────

/**
 * Sentence lengths in words: [2, 2, 2] [10, 10, 11, 13] [2] [2] — nine
 * sentences, 54 words, a mean of 6. Deviations from the mean: five of −4, two
 * of +4, one +5, one +7 → squares 112 + 25 + 49 = 186; variance 186 / 9 =
 * 20.67; sd 4.55; variation 4.55 / 6 = 0.76.
 */
const HARBOUR = [
  block('1.1', 'Ships waited. Crews waited. Prices rose.'),
  block(
    '1.2',
    'The harbour master wrote to the city council every week. The council sent him back the same reply each time. The merchants then began to borrow money against their next cargo. The banks lent them the money at a very high rate of interest.',
  ),
  block('1.3', 'Nobody paid.'),
  block('1.4', 'Nobody could.'),
];

describe('rhythmProfile on a small known text', () => {
  it('measures every number as counted by hand', () => {
    expect(rhythmProfile(HARBOUR)).toEqual({
      sentences: 9,
      meanWords: 6,
      sdWords: 4.5,
      variation: 0.76,
      // Five of the nine sentences have three words or fewer.
      fragmentShare: 0.56,
      longShare: 0,
      // "Ships waited. Crews waited. Prices rose." — the closing pair of "Nobody…" is a run of two.
      longestFragmentRun: 3,
      // No commas or clause words anywhere: one clause per sentence, no punctuation inside them.
      clausesPerSentence: 1,
      punctuationPerSentence: 0,
      // "The… The… The… The…" gives three repeats, "Nobody… Nobody…" one more.
      repeatedOpenings: 4,
      // 10, 10, 11, 13: each within two words of the one before — one run of four.
      sameLengthRuns: 1,
      // Of the three block-to-block transitions, only 1.3 → 1.4 ends short after a short ending.
      endingRepetition: 0.33,
      tongueTwisters: [],
    });
  });

  it('counts clauses and punctuation inside the sentences', () => {
    // "The guild, which … since 1550, met in secret; …": two commas, "which" and "since" → five clauses; three marks of punctuation.
    const p = rhythmProfile([block('1.1', 'The guild, which had controlled the trade since 1550, met in secret; its members voted to close the market. Prices fell.')]);
    expect(p).toMatchObject({ sentences: 2, meanWords: 10.5, sdWords: 8.5, variation: 0.81, clausesPerSentence: 3, punctuationPerSentence: 1.5, fragmentShare: 0.5, longestFragmentRun: 1 });
  });

  it('counts a sentence of more than 25 words as long', () => {
    const p = rhythmProfile([
      block(
        '1.1',
        'Some owners hid the youngest children in the cellars or sent them out into the yard whenever an inspector came to the door, and kept them there until he had gone. The inspectors knew. They wrote it down anyway.',
      ),
    ]);
    expect(p.sentences).toBe(3);
    expect(p.longShare).toBe(0.33);
  });

  it('25 words is not yet long; 26 is', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => ['the', 'guild', 'paid', 'its', 'masons', 'in', 'silver', 'every', 'spring'][i % 9]).join(' ');
    expect(rhythmProfile([block('1.1', `${words(25)}.`)]).longShare).toBe(0);
    expect(rhythmProfile([block('1.1', `${words(26)}.`)]).longShare).toBe(1);
    expect(rhythmProfile([block('1.1', `${words(25)}. ${words(26)}.`)])).toMatchObject({ sentences: 2, meanWords: 25.5, longShare: 0.5 });
  });
});

// ── Runs, openings and endings ───────────────────────────────────────────────

describe('repeated openings and same-length runs', () => {
  const FOUR = [
    'The council met in the spring of that year.',
    'The council voted to raise the bridge tolls again.',
    'The council collected the new tolls for a decade.',
    'The merchants of the town paid them without complaint.',
  ];

  it('four sentences of about the same length make a run, across the blocks of one section', () => {
    const p = rhythmProfile([block('1.1', FOUR.slice(0, 2).join(' ')), block('1.2', FOUR.slice(2).join(' '))]);
    expect(p).toMatchObject({ sentences: 4, meanWords: 9, sdWords: 0, variation: 0, sameLengthRuns: 1, repeatedOpenings: 3 });
  });

  it('three are not yet a run', () => {
    expect(rhythmProfile([block('1.1', FOUR.slice(0, 3).join(' '))])).toMatchObject({ sameLengthRuns: 0, repeatedOpenings: 2 });
  });

  it('a section boundary breaks both a run and a repeated opening', () => {
    const p = rhythmProfile([block('1.1', FOUR.slice(0, 2).join(' ')), block('2.1', FOUR.slice(2).join(' '))]);
    expect(p).toMatchObject({ sameLengthRuns: 0, repeatedOpenings: 2 });
  });

  it('short sentences never make a same-length run', () => {
    expect(rhythmProfile([block('1.1', 'Ships waited. Crews waited. Prices rose. Banks lent. Nobody paid.')])).toMatchObject({ sameLengthRuns: 0, longestFragmentRun: 5, fragmentShare: 1 });
  });

  it('a long run counts once; two runs broken by a sentence of another length count twice', () => {
    const six = [...FOUR, 'The council kept the money in a locked chest.', 'The council spent none of it on the old bridge.'];
    expect(rhythmProfile([block('1.1', six.join(' '))]).sameLengthRuns).toBe(1);
    const broken = [...FOUR, 'Nobody asked where it went.', ...FOUR];
    expect(rhythmProfile([block('1.1', broken.join(' '))]).sameLengthRuns).toBe(2);
  });

  it('fragments run on across the blocks of a section, but a section boundary breaks the run', () => {
    expect(rhythmProfile([block('1.1', 'Ships waited. Crews waited.'), block('1.2', 'Prices rose. Nobody paid.')]).longestFragmentRun).toBe(4);
    expect(rhythmProfile([block('1.1', 'Ships waited. Crews waited.'), block('2.1', 'Prices rose. Nobody paid.')])).toMatchObject({ longestFragmentRun: 2, fragmentShare: 1 });
  });
});

describe('ending repetition', () => {
  it('is the share of blocks that end the way the block before them ended — short again, or on the same word', () => {
    const p = rhythmProfile([
      block('1.1', 'The guild raised its fees for the first time that year.'),
      block('1.2', 'Half of the apprentices left the city before the end of that year.'),
      block('1.3', 'The council rebuilt the north wall. It took a decade.'),
      block('1.4', 'The masons were paid by the cartload. Nobody complained.'),
    ]);
    // 1.1 → 1.2: both end on "year"; 1.2 → 1.3: no; 1.3 → 1.4: both end on a short sentence.
    expect(p.endingRepetition).toBe(0.67);
  });

  it('is zero for a single block', () => {
    expect(rhythmProfile([block('1.1', 'It failed. It failed again.')]).endingRepetition).toBe(0);
  });

  it('reads the ending without a closing aside: the aside is not how the block ends', () => {
    const p = rhythmProfile([
      block('1.1', 'The guild raised its fees for the first time that year.'),
      block('1.2', 'Half of the apprentices left the city before the end of that year (the records give no number).'),
    ]);
    expect(p.endingRepetition).toBe(1);
  });
});

describe('variation', () => {
  it('monotonous narration varies little; narration that mixes short and long sentences varies a lot', () => {
    const monotone = rhythmProfile([
      block('1.1', 'The bank opened in 1857 with a small capital. Its directors were three merchants and a judge. Within a year it held most local savings. In the spring the price of wheat fell sharply.'),
    ]);
    const varied = rhythmProfile([
      block('1.1', 'The bank opened in 1857. Its directors were three merchants from the valley and a retired judge who had never kept a ledger in his life. It grew. Then, in the spring of 1860, wheat fell to half its price, and the farmers who had borrowed against the harvest could not pay.'),
    ]);
    expect(monotone.variation).toBeLessThan(0.3);
    expect(varied.variation).toBeGreaterThan(0.6);
    // 9, 8, 8, 9 words: mean 8.5, sd 0.5. 5, 21, 2, 24 words: mean 13, sd √92.5 = 9.6.
    expect(monotone).toMatchObject({ sentences: 4, meanWords: 8.5, sdWords: 0.5, variation: 0.06, sameLengthRuns: 1 });
    expect(varied).toMatchObject({ sentences: 4, meanWords: 13, sdWords: 9.6, variation: 0.74, sameLengthRuns: 0, fragmentShare: 0.25 });
  });
});

// ── Whose words ──────────────────────────────────────────────────────────────

describe("only the narrator's words", () => {
  it('speaker blocks leave the profile unchanged', () => {
    const withSpeaker = [...HARBOUR.slice(0, 2), block('1.3', 'We waited. We starved. We sold everything.', { speakerId: 'F1' }), ...HARBOUR.slice(2)];
    expect(rhythmProfile(withSpeaker)).toEqual(rhythmProfile(HARBOUR));
  });

  it('a quotation is the record speaking: its short sentences are not the narrator’s fragments', () => {
    const p = rhythmProfile([block('1.1', 'In his last letter the harbour master wrote to the council: "Ships wait. Crews wait. Prices rise." The council did not reply.')]);
    // "In his last letter … to the council" (11 words) and "The council did not reply." (5): the quotation counts as no words and ends its sentence.
    expect(p).toMatchObject({ sentences: 2, meanWords: 8, fragmentShare: 0, longestFragmentRun: 0 });
  });

  it('an empty script gives zeros, never NaN', () => {
    expect(rhythmProfile([])).toEqual({
      sentences: 0,
      meanWords: 0,
      sdWords: 0,
      variation: 0,
      fragmentShare: 0,
      longShare: 0,
      longestFragmentRun: 0,
      clausesPerSentence: 0,
      punctuationPerSentence: 0,
      repeatedOpenings: 0,
      sameLengthRuns: 0,
      endingRepetition: 0,
      tongueTwisters: [],
    });
    expect(rhythmProfile([block('1.1', 'Never mind.', { speakerId: 'F1' })]).sentences).toBe(0);
  });
});

// ── Tongue-twisters ──────────────────────────────────────────────────────────

describe('tongueTwister', () => {
  it.each([
    ['Six slick sailors sold seven sacks of salt.', 'words starting alike'],
    ['Peter Piper picked a peck of pickled peppers.', 'words starting alike'],
    ['She sells sea shells by the sea shore.', 'sibilants in a row'],
    ['Shipping shares shot up on Saturday.', 'sibilants in a row'],
    ['The strengths of the twelfths were measured.', 'two consonant clusters'],
  ])('"%s" trips a narrator (%s)', (sentence) => {
    expect(tongueTwister(sentence)).toBe(true);
  });

  it.each([
    ['The harbour master wrote to the city council every week.', 'ordinary narration'],
    ['Prices rose.', 'too short to trip over'],
    ['This was the third time that they had tried it there.', 'function words glide: "this, that, they, there" do not count'],
    ['The strengths of the guild lay in its accounts.', 'one consonant cluster is not enough'],
    ['The price of pepper doubled in a year.', 'a pair of alliterating words is fine'],
    ['The rhythm of the hymns was steady.', '"y" is a vowel here: "rhythm" and "hymns" are not clusters'],
  ])('"%s" does not (%s)', (sentence) => {
    expect(tongueTwister(sentence)).toBe(false);
  });

  it('rhythmProfile lists the narrator’s tongue-twisters with their block, and ignores speakers and quotations', () => {
    const p = rhythmProfile([
      block('1.1', 'The tax fell hardest on the fishmongers. She sells sea shells by the sea shore.'),
      block('1.2', 'Six slick sailors sold seven sacks of salt.', { speakerId: 'F1' }),
      block('1.3', 'The song began, "Peter Piper picked a peck of pickled peppers," and nobody could sing it.'),
      block('2.1', 'The strengths of the twelfths were measured in the guild hall.'),
    ]);
    expect(p.tongueTwisters).toEqual([
      { ref: '1.1', excerpt: 'She sells sea shells by the sea shore.' },
      { ref: '2.1', excerpt: 'The strengths of the twelfths were measured in the guild hall.' },
    ]);
  });

  it('clips a long tongue-twister to 80 characters in the profile', () => {
    const long = 'Six slick sailors sold seven sacks of salt to the steward of the ship before the storm broke over the harbour.';
    const [twister] = rhythmProfile([block('1.1', long)]).tongueTwisters;
    expect(twister!.excerpt).toHaveLength(80);
    expect(twister!.excerpt.endsWith('…')).toBe(true);
    expect(long.startsWith(twister!.excerpt.slice(0, -1))).toBe(true);
  });
});
