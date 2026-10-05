import { AI_PATTERNS, type AiPattern, type AiSignal } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { STOCK_PHRASES, actionable, aiSignals, blockPatterns, describesPicture, overThreshold, summarise } from './fingerprints.ts';
import type { NarrationBlock } from './text.ts';

/**
 * The AI-pattern detector: HARD patterns are wrong wherever they appear,
 * DENSITY patterns only once they pile up. The detector must catch the
 * habits of machine-written narration and leave ordinary documentary prose —
 * on any subject — alone.
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

/** A film from its sections, each a list of block texts: blocks are keyed "1.1", "1.2", "2.1"… */
const film = (...sections: string[][]) => sections.flatMap((texts, s) => texts.map((t, b) => block(`${s + 1}.${b + 1}`, t)));
const one = (text: string) => [block('1.1', text)];

const of = (signals: readonly AiSignal[], pattern: AiPattern) => signals.filter((s) => s.pattern === pattern);
const patternsOf = (signals: readonly AiSignal[]) => [...new Set(signals.map((s) => s.pattern))].sort();

/** Everything the detector says about some blocks: every signal, the ones to act on, and the summary. */
function detect(blocks: readonly NarrationBlock[]) {
  const signals = aiSignals(blocks);
  const summary = summarise(blocks, signals);
  return { signals, summary, actionable: actionable(signals, summary.words) };
}

// ── The brief's own examples ─────────────────────────────────────────────────

describe("the brief's own examples", () => {
  it('flags the watching, the shrugging table and the leaning as narration describing the picture', () => {
    const { signals, actionable: act, summary } = detect(one('From a corner bench, Thijs watches a thumb wipe a figure away. The table shrugs. He leans closer.'));
    expect(of(signals, 'visual_description').map((s) => s.excerpt)).toEqual(['From a corner bench, Thijs watches a thumb wipe a figure away.', 'The table shrugs.', 'He leans closer.']);
    expect(of(signals, 'visual_description').every((s) => s.kind === 'HARD' && s.ref === '1.1')).toBe(true);
    expect(patternsOf(act)).toEqual(['visual_description']);
    // Three HARD signals in three sentences: 9 / 4.5 → capped at 100.
    expect(summary).toMatchObject({ score: 100, signals: 3, overThreshold: ['visual_description'] });
  });

  it('allows a single "not a flower — a promise" contrast: one DENSITY signal, nothing to act on, a score of zero', () => {
    const { signals, actionable: act, summary } = detect(one("What changes hands is not a flower. It's a promise."));
    expect(signals).toEqual([{ pattern: 'contrast_formula', ref: '1.1', excerpt: "What changes hands is not a flower. It's a promise.", kind: 'DENSITY' }]);
    expect(act).toEqual([]);
    expect(summary).toMatchObject({ score: 0, signals: 0, overThreshold: [], perPattern: { contrast_formula: 1 } });
  });

  it('leaves the price passage alone: a figure, what it meant, and a plain observation', () => {
    const { signals, summary } = detect(
      one("The price reached 385 guilders by January 23rd. For a skilled worker, that was an enormous sum. And the strange part was that many of the traders hadn't even seen the bulbs they were buying."),
    );
    expect(signals).toEqual([]);
    expect(summary.score).toBe(0);
  });

  it('never calls a single short sentence a fragment run', () => {
    const { signals } = detect(one('She could not hear the applause. She saw it. She wrote, she taught, and she listened with her hands.'));
    expect(of(signals, 'fragment_run')).toEqual([]);
    expect(signals).toEqual([]);
  });
});

// ── Rhetorical questions ─────────────────────────────────────────────────────

describe('rhetorical questions', () => {
  it('two questions in a row are a HARD signal, whatever the length of the script', () => {
    const { signals, actionable: act } = detect(one('Who paid for the bridge? And who kept the tolls? The council records do not say.'));
    const hard = of(signals, 'rhetorical_question').filter((s) => s.kind === 'HARD');
    expect(hard).toEqual([{ pattern: 'rhetorical_question', ref: '1.1', excerpt: 'Who paid for the bridge? And who kept the tolls?', kind: 'HARD' }]);
    // Each question is also a DENSITY signal; with a HARD run in the script the pattern warns, so all three are actionable.
    expect(act).toEqual([
      { pattern: 'rhetorical_question', ref: '1.1', excerpt: 'Who paid for the bridge?', kind: 'DENSITY' },
      { pattern: 'rhetorical_question', ref: '1.1', excerpt: 'And who kept the tolls?', kind: 'DENSITY' },
      ...hard,
    ]);
    // A HARD finding stays actionable in a script of any length.
    expect(actionable(signals, 10_000).filter((s) => s.kind === 'HARD')).toEqual(hard);
  });

  it('a run of questions across two blocks of one section is still a run', () => {
    const { signals } = detect(film(['The bridge cost more than the town had ever spent. Who paid for it?', 'Who kept the tolls? The council records do not say.']));
    expect(of(signals, 'rhetorical_question').filter((s) => s.kind === 'HARD')).toEqual([
      { pattern: 'rhetorical_question', ref: '1.2', excerpt: 'Who paid for it? Who kept the tolls?', kind: 'HARD' },
    ]);
  });

  it('a single question is a DENSITY signal and warns only past its threshold', () => {
    const { signals, actionable: act, summary } = detect(one('Who paid for the bridge? The council records do not say, though the tolls went to the mayor for twelve years.'));
    expect(signals).toEqual([{ pattern: 'rhetorical_question', ref: '1.1', excerpt: 'Who paid for the bridge?', kind: 'DENSITY' }]);
    expect(act).toEqual([]);
    expect(summary.score).toBe(0);
  });

  it('separated questions warn once there are more than one per minute of narration', () => {
    const questions = film([
      'Who paid for the bridge? The council minutes name three merchants and a widow.',
      'Why did the tolls double in 1712? The ledger gives no reason for it.',
      'Who decided where it would stand? A surveyor from the next county drew the plans.',
      'How long did it take to build? The masons were paid for eleven seasons of work.',
      'Who crossed it first? A cattle drover, according to the parish register.',
    ]);
    const signals = aiSignals(questions);
    expect(signals.every((s) => s.pattern === 'rhetorical_question' && s.kind === 'DENSITY')).toBe(true);
    expect(signals).toHaveLength(5);
    // Five questions in under a minute is too many…
    expect(overThreshold(signals, 75)).toEqual(['rhetorical_question']);
    expect(actionable(signals, 75)).toHaveLength(5);
    // …five over four minutes (600 words) is one too many…
    expect(actionable(signals, 600)).toHaveLength(5);
    // …and over five minutes it is within the allowance.
    expect(actionable(signals, 750)).toEqual([]);
    // Two questions in a short script already warn.
    expect(actionable(signals.slice(0, 2), 75)).toHaveLength(2);
  });

  it('a question at the end of one section and another at the start of the next are not a run', () => {
    const { signals } = detect(film(['The bridge cost more than the town had ever spent. Who paid for it?'], ['Who kept the tolls? The council records do not say.']));
    expect(of(signals, 'rhetorical_question').map((s) => s.kind)).toEqual(['DENSITY', 'DENSITY']);
  });

  it('a question inside a quotation is not the narrator asking', () => {
    const { signals } = detect(one('The clerk wrote in the margin, "Who will pay for this?" Nobody answered him in the minutes.'));
    expect(signals).toEqual([]);
  });

  it('"The result? Chaos." is a question answered at once by a fragment', () => {
    const { signals, actionable: act } = detect(one('The result? Chaos.'));
    expect(of(signals, 'qa_pair')).toEqual([{ pattern: 'qa_pair', ref: '1.1', excerpt: 'The result? Chaos.', kind: 'DENSITY' }]);
    expect(act).toEqual([]);
    const twice = detect(film(['The council voted to double the tolls. The result? Riots.', 'The mayor called in the militia. The cost? Ruinous.']));
    expect(of(twice.actionable, 'qa_pair').map((s) => [s.ref, s.excerpt])).toEqual([
      ['1.1', 'The result? Riots.'],
      ['1.2', 'The cost? Ruinous.'],
    ]);
  });

  it('a longer question, or a longer answer, is not the clipped question-and-answer habit', () => {
    // Question of eight words; answer of eight words.
    expect(of(aiSignals(one('Who in the whole town paid for the bridge? Nobody.')), 'qa_pair')).toEqual([]);
    expect(of(aiSignals(one('The result? Chaos in the streets of the city.')), 'qa_pair')).toEqual([]);
  });
});

// ── Fragments ────────────────────────────────────────────────────────────────

describe('fragment runs', () => {
  it('three very short sentences in a row are a DENSITY fragment run', () => {
    const { signals, actionable: act } = detect(one('Production slowed. Wages fell. Strikes began. The owners did nothing for another two years.'));
    expect(signals).toEqual([{ pattern: 'fragment_run', ref: '1.1', excerpt: 'Production slowed. Wages fell. Strikes began.', kind: 'DENSITY' }]);
    expect(act).toEqual([]);
  });

  it('two runs in a script are formulaic and warn', () => {
    const { signals, actionable: act } = detect(
      film(['Production slowed. Wages fell. Strikes began. The owners did nothing for another two years.'], ['The mills closed one by one. Families left. Shops shut. Churches emptied.']),
    );
    expect(of(signals, 'fragment_run').map((s) => s.ref)).toEqual(['1.1', '2.1']);
    expect(of(act, 'fragment_run')).toHaveLength(2);
  });

  it('one or two short sentences never make a run', () => {
    expect(aiSignals(one('Production slowed. Wages fell.'))).toEqual([]);
    expect(aiSignals(one('Production slowed in the spring of 1910. Wages fell. By the autumn the first strike had begun in the dye works.'))).toEqual([]);
  });

  it('a run continues across the blocks of a section, but not across sections', () => {
    const within = of(aiSignals(film(['The orders stopped in March. Wages fell.', 'Strikes began. Mills closed. The owners did nothing for a year.'])), 'fragment_run');
    expect(within).toEqual([{ pattern: 'fragment_run', ref: '1.2', excerpt: 'Wages fell. Strikes began. Mills closed.', kind: 'DENSITY' }]);
    const across = of(aiSignals(film(['The orders stopped in March. Wages fell. Strikes began.'], ['Mills closed. The owners did nothing for a year.'])), 'fragment_run');
    expect(across).toEqual([]);
  });
});

// ── Fake dramatic transitions ────────────────────────────────────────────────

describe('fake dramatic transitions', () => {
  it.each([
    'And then the bank failed.',
    'But then the letters stopped coming.',
    "That's when the second ship arrived.",
    "That's when everything went wrong for the company.",
    'But this was only the beginning.',
    'Everything was about to change.',
    'This is where everything changed.',
    'What happened next shocked the town.',
    'But there was one problem.',
    'It all began with a letter.',
    "The story doesn't end there.",
    'That decision would change everything.',
  ])('flags "%s" as a HARD dramatic transition', (line) => {
    const { signals, actionable: act } = detect(one(line));
    expect(of(signals, 'dramatic_transition')).toEqual([{ pattern: 'dramatic_transition', ref: '1.1', excerpt: line, kind: 'HARD' }]);
    expect(of(act, 'dramatic_transition')).toHaveLength(1);
  });

  it('reports a sentence once per pattern, even when several of its rules match', () => {
    // "That's when" opens the sentence and "that's when everything" follows: one beat, one signal.
    const { signals, summary } = detect(film(['The firm had survived two recessions. That\'s when everything went wrong for the company.', 'Its largest customer cancelled every order in a single week.']));
    expect(of(signals, 'dramatic_transition')).toEqual([{ pattern: 'dramatic_transition', ref: '1.1', excerpt: "That's when everything went wrong for the company.", kind: 'HARD' }]);
    expect(summary.signals).toBe(1);
    // One HARD signal in three sentences: 3 / 4.5.
    expect(summary.score).toBe(67);
  });

  it('"Little did they know" is a stock phrase, wherever it appears', () => {
    const { signals, actionable: act } = detect(one('Little did they know what the auditors would find.'));
    expect(signals).toEqual([{ pattern: 'stock_phrase', ref: '1.1', excerpt: 'little did they know', kind: 'HARD' }]);
    expect(act).toHaveLength(1);
  });

  it('"Everything was about to change" closing a block is also a micro-hook', () => {
    expect(blockPatterns(block('1.1', 'The mill had run for a century. Everything was about to change.'))).toEqual(['dramatic_transition', 'micro_hook']);
    expect(blockPatterns(block('1.1', 'Everything was about to change. Within a year the mill had closed and its looms were sold for scrap.'))).toEqual(['dramatic_transition']);
  });

  it('every repetition of the habit is a signal of its own, and the score climbs with them', () => {
    const once = detect(one('And then the bank failed. The town lost its savings. The mayor resigned in the spring. The mill closed in the summer.'));
    const thrice = detect(one('And then the bank failed. And then the town lost its savings. And then the mayor resigned. The mill closed in the summer.'));
    expect(of(once.signals, 'dramatic_transition')).toHaveLength(1);
    expect(of(thrice.signals, 'dramatic_transition')).toHaveLength(3);
    expect(thrice.summary.score).toBeGreaterThan(once.summary.score);
  });

  it('ordinary uses of the same words are not transitions', () => {
    for (const line of [
      'He sold the house and then the land.',
      'It was the beginning of the season.',
      'That was the year the canal opened.',
      'The beginning of the war found him in Lisbon.',
      'Prices were expected to change after the harvest.',
    ])
      expect(aiSignals(one(line)), line).toEqual([]);
  });
});

// ── Hype, "Imagine…", trailer and mystery language ───────────────────────────

describe('hype adverbs and "Imagine…" openers', () => {
  it.each(['Incredibly, the bridge stood for another forty years.', 'Remarkably, nobody was hurt.', 'Shockingly, the auditors signed the accounts.'])('flags the opener in "%s"', (line) => {
    expect(aiSignals(one(line))).toEqual([{ pattern: 'hype_adverb', ref: '1.1', excerpt: line, kind: 'HARD' }]);
  });

  it('an adverb inside the sentence is ordinary English', () => {
    expect(aiSignals(one('It was a remarkably cold winter, and the canals froze in November.'))).toEqual([]);
  });

  it.each(['Imagine a city without clean water.', 'Picture this: a harbour full of ships and no one to unload them.', 'Now, imagine the noise of the trading floor.', 'Close your eyes and listen to the looms.'])('flags "%s" as an Imagine opener', (line) => {
    expect(of(aiSignals(one(line)), 'imagine_opener')).toEqual([{ pattern: 'imagine_opener', ref: '1.1', excerpt: line, kind: 'HARD' }]);
  });

  it('"imagine" as a verb in a sentence is not an opener', () => {
    expect(aiSignals(one('Few people in 1850 could imagine a city without walls.'))).toEqual([]);
  });

  it('"What if…" is a DENSITY opener: once is allowed', () => {
    const { signals, actionable: act } = detect(one('What if the vote had gone the other way? The archive has the tally: one vote decided it.'));
    expect(of(signals, 'imagine_opener')).toEqual([{ pattern: 'imagine_opener', ref: '1.1', excerpt: 'What if the vote had gone the other way?', kind: 'DENSITY' }]);
    expect(act).toEqual([]);
  });
});

describe('trailer, mystery and explained emotion', () => {
  it.each<[string, AiPattern]>([
    ['It was destiny.', 'trailer_language'],
    ['Against all odds, the expedition reached the coast.', 'trailer_language'],
    ['It is a story of greed, betrayal and ruin.', 'trailer_language'],
    ['The deal was shrouded in mystery.', 'mystery_language'],
    ['This is the untold story of the canal.', 'mystery_language'],
    ['A palpable sense of dread filled the room.', 'emotion_explained'],
    ["Here's the thing: nobody checked the books.", 'truth_reveal'],
  ])('flags "%s" (%s)', (line, pattern) => {
    const { signals } = detect(one(line));
    expect(signals).toEqual([{ pattern, ref: '1.1', excerpt: line, kind: 'HARD' }]);
  });

  it('"The truth is…" is fine once and formulaic twice', () => {
    const once = detect(one('The truth is that the ledgers were forged. The auditor found two sets of books in the cellar.'));
    expect(of(once.signals, 'truth_reveal').map((s) => s.kind)).toEqual(['DENSITY']);
    expect(once.actionable).toEqual([]);
    const twice = detect(film(['The truth is that the ledgers were forged. The auditor found two sets of books in the cellar.', 'In reality, the partners had known for a year. Their letters say so plainly.']));
    expect(of(twice.actionable, 'truth_reveal')).toHaveLength(2);
  });
});

// ── Micro-hook endings ───────────────────────────────────────────────────────

describe('micro-hook endings', () => {
  it.each(['But not for long.', 'Or so they thought.', 'The peace did not last.', 'Nobody saw it coming.', 'But the worst was yet to come.', 'They had no idea what the inspectors would find.'])(
    'a block closing on "%s" is a HARD micro-hook',
    (closer) => {
      const { signals } = detect(one(`The council approved the new tolls in March. ${closer}`));
      expect(of(signals, 'micro_hook')).toEqual([{ pattern: 'micro_hook', ref: '1.1', excerpt: closer, kind: 'HARD' }]);
    },
  );

  it('the same sentence in the middle of a block, followed by what happened, is not a tease', () => {
    expect(aiSignals(one('The peace did not last. Within a year the two towns were at war again over the river tolls.'))).toEqual([]);
  });
});

// ── "Not X, but Y" ───────────────────────────────────────────────────────────

describe('"not X, but Y" contrasts', () => {
  it('one contrast is a DENSITY signal and is not actionable, in either form', () => {
    for (const text of ["It wasn't a strike. It was a lockout.", 'The dispute was not about wages, but about who would run the mill.']) {
      const { signals, actionable: act } = detect(one(text));
      expect(signals.map((s) => [s.pattern, s.kind]), text).toEqual([['contrast_formula', 'DENSITY']]);
      expect(act, text).toEqual([]);
    }
  });

  it('a single contrast followed by a sentence starting "It was" is still one contrast', () => {
    const { signals, actionable: act } = detect(one('It was not a strike, but a lockout. It was the owners who closed the gates.'));
    expect(of(signals, 'contrast_formula')).toEqual([{ pattern: 'contrast_formula', ref: '1.1', excerpt: 'It was not a strike, but a lockout.', kind: 'DENSITY' }]);
    expect(act).toEqual([]);
  });

  it.each([
    "It's not about the money. It's about power.",
    "They're not farmers. They're speculators.",
    "They aren't farmers. They are speculators.",
    "That's not how it worked. It was a lottery.",
    "It isn't a market. It's a casino.",
  ])('the contracted and present-tense forms are the same formula: "%s"', (text) => {
    expect(aiSignals(one(text))).toEqual([{ pattern: 'contrast_formula', ref: '1.1', excerpt: text, kind: 'DENSITY' }]);
  });

  it('a hedge is not a contrast, but "known for" is: only uncertainty about the record is spared', () => {
    for (const hedge of [
      "It's not clear who ordered it. It's possible that nobody did.",
      'It is not clear from the records whether he paid. It was, at least, promised.',
      'It is not recorded. It was, in any case, never repaid.',
      'It was not certain that the ship had sailed. It was, by then, a month overdue.',
    ])
      expect(aiSignals(one(hedge)), hedge).toEqual([]);
    const known = "It wasn't known for its tulips. It was known for its herring.";
    expect(aiSignals(one(known))).toEqual([{ pattern: 'contrast_formula', ref: '1.1', excerpt: known, kind: 'DENSITY' }]);
  });

  it('"It\'s nothing like…" is not a negation', () => {
    expect(aiSignals(one("It's nothing like the first auction. It's smaller."))).toEqual([]);
  });

  it('several contrasts in a short script are past the threshold and all of them are actionable', () => {
    const { signals, actionable: act, summary } = detect(
      film(['It was not a strike, but a lockout. It was not a protest, but a riot. It was not a debate, but a purge.']),
    );
    expect(of(signals, 'contrast_formula').map((s) => s.excerpt)).toEqual(['It was not a strike, but a lockout.', 'It was not a protest, but a riot.', 'It was not a debate, but a purge.']);
    expect(summary.overThreshold).toEqual(['contrast_formula']);
    expect(of(act, 'contrast_formula')).toHaveLength(3);
    // Three DENSITY signals past their threshold, in three sentences: 3 / 4.5.
    expect(summary.score).toBe(67);
  });

  it('"It wasn\'t X. It wasn\'t Y. It was Z." is one contrast, not two', () => {
    expect(aiSignals(one('It was not a strike. It was not a protest. It was a lockout.'))).toEqual([
      { pattern: 'contrast_formula', ref: '1.1', excerpt: 'It was not a protest. It was a lockout.', kind: 'DENSITY' },
    ]);
  });

  it('the allowance grows with the length of the script', () => {
    const signals = aiSignals(film(["It wasn't a strike. It was a lockout.", 'The dispute was not about wages, but about who would run the mill.']));
    expect(signals).toHaveLength(2);
    expect(actionable(signals, 200)).toHaveLength(2);
    // Two in a script of 2,000 words (over thirteen minutes) is a device, not a habit.
    expect(actionable(signals, 2000)).toEqual([]);
  });
});

// ── Em-dashes ────────────────────────────────────────────────────────────────

describe('em-dash density', () => {
  it('a block leaning on dashes is a DENSITY signal; three such blocks in a short script warn', () => {
    const dashed = [
      'The cost was high — far higher than the partners expected — and the bank knew it.',
      'The second loan – larger than the first – was signed in June.',
      'The third -- and last -- came in the autumn.',
    ];
    const single = detect(film(dashed.slice(0, 1)));
    expect(single.signals).toEqual([{ pattern: 'em_dash', ref: '1.1', excerpt: '2 dashes', kind: 'DENSITY' }]);
    expect(single.actionable).toEqual([]);
    const three = detect(film(dashed));
    expect(of(three.signals, 'em_dash').map((s) => s.ref)).toEqual(['1.1', '1.2', '1.3']);
    expect(of(three.actionable, 'em_dash')).toHaveLength(3);
    // The same three blocks in a script of 1,200 words are within the allowance (one per 400 words).
    expect(overThreshold(three.signals, 1200)).toEqual([]);
    expect(actionable(three.signals, 1200)).toEqual([]);
    expect(actionable(three.signals, 1199)).toHaveLength(3);
  });

  it('a single dash and hyphenated words are not dash density', () => {
    // Two dashes, not three: the hyphen in "well-known" is not one.
    expect(aiSignals(one('The well-known merchant sold his share — all of it — in 1637.'))).toEqual([{ pattern: 'em_dash', ref: '1.1', excerpt: '2 dashes', kind: 'DENSITY' }]);
    expect(aiSignals(one('The well-known merchant sold his share in 1637 — all of it.'))).toEqual([]);
    expect(aiSignals(one('The twenty-two-year-old clerk kept a day-by-day record of the sale.'))).toEqual([]);
  });
});

// ── Repeated endings and same-length runs ────────────────────────────────────

describe('repeated endings', () => {
  it('blocks that keep closing on a short sentence warn from the third such block on', () => {
    const { signals, actionable: act } = detect(
      film([
        'The first well was dug in the spring of 1902 on a farm outside the town. It failed.',
        'A second crew drilled four hundred feet deeper through the summer and into the autumn. It failed too.',
        'The investors sent an engineer from the coast with new equipment and a bigger budget. He gave up.',
        'By the winter the company had spent everything it had raised from the town. Then it folded.',
      ]),
    );
    expect(of(signals, 'repeated_ending')).toEqual([
      { pattern: 'repeated_ending', ref: '1.3', excerpt: 'He gave up.', kind: 'DENSITY' },
      { pattern: 'repeated_ending', ref: '1.4', excerpt: 'Then it folded.', kind: 'DENSITY' },
    ]);
    expect(of(act, 'repeated_ending')).toHaveLength(2);
  });

  it('blocks that keep ending on the same word repeat too', () => {
    const signals = aiSignals(
      film([
        'The guild raised its fees for the first time that year.',
        'Half of the apprentices left the city before the end of that year.',
        'The council, short of masons, rebuilt only the north wall that year.',
      ]),
    );
    expect(of(signals, 'repeated_ending').map((s) => s.ref)).toEqual(['1.3']);
  });

  it('varied endings are left alone', () => {
    const signals = aiSignals(
      film([
        'The first well was dug in the spring of 1902 on a farm outside the town. It failed.',
        'A second crew drilled four hundred feet deeper through the summer, and in October it struck oil.',
        'Within a year the town had three refineries and a railway spur.',
      ]),
    );
    expect(of(signals, 'repeated_ending')).toEqual([]);
  });
});

describe('same-length sentence runs', () => {
  const monotone = 'The harbour master wrote to the city council every week. The council sent him back the same reply each time. The merchants began to borrow money against their next cargo. The banks lent them the money at a very high rate.';

  it('four sentences of about the same length in a row are a DENSITY signal', () => {
    const { signals, actionable: act } = detect(one(monotone));
    expect(signals).toEqual([{ pattern: 'length_repetition', ref: '1.1', excerpt: '4 sentences of about 10 words', kind: 'DENSITY' }]);
    expect(act).toEqual([]);
  });

  it('two such runs warn', () => {
    const { actionable: act } = detect(film([monotone], ['The first ships came back empty in the spring. The second fleet was lost in a storm off Texel. The insurers refused to pay for either of them. The banks called in their loans by the summer.']));
    expect(of(act, 'length_repetition')).toHaveLength(2);
  });

  it('sentences that vary their length do not', () => {
    expect(
      aiSignals(one('The harbour master wrote to the city council every week. Nothing came back. By March the merchants had begun to borrow against cargo that had not yet left the Baltic, at rates no bank would offer now. The banks obliged.')),
    ).toEqual([]);
  });
});

// ── Metaphor clichés ─────────────────────────────────────────────────────────

describe('metaphor clichés', () => {
  it.each(['The settlement was a house of cards.', 'The new tax was a ticking time bomb.', 'By 1913 the region was a powder keg.', 'The missing ledgers were only the tip of the iceberg.'])(
    'flags the stock figure in "%s"',
    (line) => {
      expect(aiSignals(one(line))).toEqual([{ pattern: 'metaphor_stack', ref: '1.1', excerpt: line, kind: 'HARD' }]);
    },
  );

  it('figures of speech piled into one block are DENSITY; two such blocks warn', () => {
    const piled = 'The market moved like a wave, like a fever, as if every trader had heard the same rumour.';
    const { signals, actionable: act } = detect(one(piled));
    expect(signals).toEqual([{ pattern: 'metaphor_stack', ref: '1.1', excerpt: '3 figures of speech', kind: 'DENSITY' }]);
    expect(act).toEqual([]);
    const twice = detect(film([piled, 'Rumours spread like a fire in a dry field, as though the whole city had caught the same disease.']));
    expect(of(twice.actionable, 'metaphor_stack')).toHaveLength(2);
  });

  it('one plain simile is fine', () => {
    expect(aiSignals(one('On auction days the inn filled like a theatre, and the landlord charged for every chair.'))).toEqual([]);
  });
});

// ── Visual redundancy ────────────────────────────────────────────────────────

describe('narration describing the picture', () => {
  it.each([
    'Candlelight flickers across the table.',
    'Dust drifts through the light of the window.',
    'He glances at the door.',
    'She nods.',
    'The scales shrug.',
    'In this engraving we see the harbour at dusk.',
    'On screen, the harbour fills with ships.',
    'You can see the cracks in the dam wall.',
  ])('"%s" is a HARD visual_description', (line) => {
    const { signals, actionable: act } = detect(one(line));
    expect(signals).toEqual([{ pattern: 'visual_description', ref: '1.1', excerpt: line, kind: 'HARD' }]);
    expect(act).toHaveLength(1);
    expect(describesPicture(line)).toBe(true);
  });

  it('a gesture that carries information the picture cannot is narration', () => {
    expect(describesPicture('He nods to the clerk because the price has doubled.')).toBe(false);
    expect(describesPicture('She smiles at the court, and the contract is signed for 1,200 guilders.')).toBe(false);
    expect(aiSignals(one('He nods to the clerk because the price has doubled.'))).toEqual([]);
  });

  it("narration that repeats the block's own visual note is redundant; the same words without that note, or with new facts, are not", () => {
    const visual = { note: 'Close-up of the signed contract on the merchant desk, wax seal broken', mustShow: [{ detail: 'the broken wax seal' }] };
    const echo = "The signed contract lies on the merchant's desk, its wax seal broken.";
    expect(aiSignals([block('1.1', echo, { visual })])).toEqual([{ pattern: 'visual_description', ref: '1.1', excerpt: echo, kind: 'HARD' }]);
    expect(describesPicture(echo, visual)).toBe(true);
    expect(aiSignals([block('1.1', echo)])).toEqual([]);
    expect(describesPicture(echo)).toBe(false);
    const informs = 'The contract obliged him to deliver forty barrels of herring by the first of May.';
    expect(aiSignals([block('1.1', informs, { visual })])).toEqual([]);
  });

  it('ambient movement is a picture only with something seen: prices, credit and doubt drift, hover and tighten too', () => {
    for (const line of ['Smoke curls from the chimney.', 'Her eyes narrow.', 'Light dances on the water of the canal.']) expect(describesPicture(line), line).toBe(true);
    for (const line of ['Credit tightens.', 'Prices hover near their peak.', 'The gap narrows.', 'Doubt lingers.', 'Interest rates drift upward.', 'Confidence flickers.', 'Rumours swirl.']) {
      expect(describesPicture(line), line).toBe(false);
      expect(aiSignals(one(line)), line).toEqual([]);
    }
  });

  it('a thin visual note is not enough to call narration an echo', () => {
    const visual = { note: 'Contract', mustShow: [] };
    expect(describesPicture('The signed contract was witnessed by two aldermen.', visual)).toBe(false);
  });
});

// ── Precision: human documentary prose, quotations, speakers, hedges ─────────

/** Plain narration on seven unrelated subjects, written the way a documentary editor would want it. */
const HUMAN_PROSE: Record<string, string[][]> = {
  'public health (cholera, 1854)': [
    [
      'In the late summer of 1854, cholera came to Soho. Within ten days, more than five hundred people living within a few streets of Broad Street had died.',
      'The accepted explanation was bad air. John Snow, a physician who had spent years tracing earlier outbreaks, suspected the water instead.',
      'He went door to door and marked each death on a map. Most of them clustered around a single public pump.',
    ],
    [
      'On the evening of September 7th, Snow put his evidence before the local board of guardians. They were not convinced, but they agreed to remove the pump handle the next day.',
      'The outbreak was already fading by then, and Snow admitted as much. What the map did was harder to dismiss: it showed where the deaths were, and where they were not.',
    ],
  ],
  'engineering (the 1858 telegraph cable)': [
    [
      'The first transatlantic telegraph cable was landed in August 1858. It carried a message from Queen Victoria to President Buchanan, ninety-eight words that took more than sixteen hours to send.',
      'Within weeks the signal grew faint. The chief electrician, Wildman Whitehouse, raised the voltage to push messages through, and the insulation failed.',
    ],
    [
      'By October the cable was silent. Investors had lost most of their money, and some newspapers suggested the whole thing had been a hoax.',
      'It took another eight years, a larger ship and a better-insulated cable before a lasting connection was made.',
    ],
  ],
  'business (Swiss watchmaking and quartz)': [
    [
      'In 1970, Swiss factories made roughly half the watches sold in the world. A decade later, their share had fallen to around fifteen percent.',
      'The cause was a cheaper way of keeping time. A quartz crystal, driven by a battery, kept better time than the finest mechanical movement, and it could be made in large numbers.',
      'Swiss engineers had built one of the first quartz prototypes themselves, in 1967. Their employers saw it as a curiosity.',
    ],
    ['Tens of thousands of jobs went. The industry survived by merging its largest firms and, in 1983, by launching a plastic watch that sold for about fifty francs.'],
  ],
  'spaceflight (Apollo 13)': [
    [
      'Apollo 13 was two days out from Earth when an oxygen tank in the service module exploded. The crew lost most of their power and much of their water.',
      'Mission control in Houston decided against turning the spacecraft around. Instead, it would swing around the Moon and use the lunar module as a lifeboat.',
      'The lunar module had been built to keep two men alive for about two days. It now had to keep three alive for four.',
    ],
    [
      'Carbon dioxide was the most urgent problem. Engineers on the ground worked out how to fit square filters into a round socket using plastic bags, cardboard and tape, and read the instructions up to the crew.',
      'On April 17th, 1970, the command module splashed down in the Pacific. All three men survived.',
    ],
  ],
  'biography (John Harrison and longitude)': [
    [
      'John Harrison was a carpenter from Lincolnshire with no formal training in science. In 1730 he travelled to London with drawings for a clock that could keep time at sea.',
      'The prize on offer was twenty thousand pounds, set by Parliament in 1714 for a practical way of finding longitude. It was probably more money than Harrison had ever seen.',
    ],
    [
      'He spent the next three decades building four timekeepers. The fourth, little bigger than a pocket watch, lost about five seconds on a voyage to Jamaica in 1761.',
      'The Board of Longitude was slow to pay. Harrison received the bulk of his reward only in 1773, three years before he died, and then largely through the intervention of the King.',
    ],
  ],
  'archaeology (Sutton Hoo)': [
    [
      'In the summer of 1939, a local excavator named Basil Brown began digging into the largest of the mounds at Sutton Hoo. The landowner, Edith Pretty, had asked him to.',
      'Under the mound he found the outline of a ship, twenty-seven metres long. The wood had rotted away, but the rivets were still in their rows.',
    ],
    [
      'In the burial chamber lay gold buckles, silver bowls and a helmet crushed into hundreds of pieces. Whoever was buried there had been very important, perhaps a king of East Anglia.',
      'Whose grave was it? Nobody knows for certain. There was no body, and the acidic soil may have dissolved it.',
    ],
  ],
  'finance (the panic of 1907)': [
    [
      'In October 1907, a failed attempt to corner the shares of a copper company brought down the banks that had lent the money for it. By morning, depositors were queueing outside the Knickerbocker Trust.',
      'Credit tightens quickly in a panic. Within days, the rate on overnight loans in New York had passed one hundred percent, and brokers could not borrow to settle their trades.',
    ],
    [
      "There was no central bank to step in. John Pierpont Morgan, then seventy years old, called the city's bankers to his library and kept them there until they agreed to pool their reserves.",
      'Share prices drifted lower for weeks after the worst had passed. The episode persuaded Congress that the country needed a lender of last resort, and in 1913 it created the Federal Reserve.',
    ],
  ],
};

describe('precision on human documentary prose', () => {
  it.each(Object.entries(HUMAN_PROSE))('%s: nothing to act on and a score of zero', (_subject, sections) => {
    const { signals, actionable: act, summary } = detect(film(...sections));
    expect(act).toEqual([]);
    expect(signals.filter((s) => s.kind === 'HARD')).toEqual([]);
    expect(summary.score).toBe(0);
    expect(summary.overThreshold).toEqual([]);
    expect(summary.words).toBeGreaterThan(90);
  });

  it('all seven subjects run together as one long film still read as written by a person', () => {
    const sections = Object.values(HUMAN_PROSE).flat();
    const { actionable: act, summary } = detect(film(...sections));
    expect(act).toEqual([]);
    expect(summary.score).toBe(0);
  });

  it('quotations are masked: a quoted "And then" is the record speaking, not the narrator', () => {
    for (const text of [
      'His diary for that week has a single line: "And then the water came." Nobody else in the village wrote anything at all.',
      'His diary for that week has a single line: “And then the water came.” Nobody else in the village wrote anything at all.',
      '"And then the water came," he wrote. Nobody else in the village wrote anything at all.',
      'The pamphlet promised "a turning point in history, shrouded in mystery." It sold four hundred copies.',
    ])
      expect(aiSignals(one(text)), text).toEqual([]);
    // Unquoted, the same words are the narrator's.
    expect(patternsOf(aiSignals(one('And then the water came. Nobody else in the village wrote anything at all.')))).toEqual(['dramatic_transition']);
  });

  it("a quotation that ends its sentence does not swallow the narrator's next one", () => {
    expect(aiSignals(one('The mayor wrote to the council: "We are ruined." And then the bank failed.'))).toEqual([
      { pattern: 'dramatic_transition', ref: '1.1', excerpt: 'And then the bank failed.', kind: 'HARD' },
    ]);
    expect(aiSignals(one('The mayor wrote to the council: “We are ruined.” Incredibly, the bank survived.'))).toEqual([
      { pattern: 'hype_adverb', ref: '1.1', excerpt: 'Incredibly, the bank survived.', kind: 'HARD' },
    ]);
    expect(of(aiSignals(one('The council replied: "The tolls will stay." But not for long.')), 'micro_hook')).toEqual([
      { pattern: 'micro_hook', ref: '1.1', excerpt: 'But not for long.', kind: 'HARD' },
    ]);
    // A quotation followed by its attribution is one sentence, and the quoted question is not the narrator's.
    expect(aiSignals(one('"Who will pay for the bridge?" the clerk asked. The minutes record no answer.'))).toEqual([]);
  });

  it("speaker blocks are the cast's words: no signals, and their words do not count as narration", () => {
    const speaker = block('1.2', 'And then everything was about to change. Little did they know.', { speakerId: 'F1' });
    expect(aiSignals([speaker])).toEqual([]);
    expect(blockPatterns(speaker)).toEqual([]);
    const narrator = block('1.1', 'The guild met twice that year.');
    const { signals, summary } = detect([narrator, speaker]);
    expect(signals).toEqual([]);
    expect(summary.words).toBe(6);
  });

  it('hedges are never flagged: uncertainty is the house style, not a machine habit', () => {
    const { signals, actionable: act, summary } = detect(
      film(
        [
          'The records suggest he was probably in Leiden that winter. It seems likely that he knew the buyer, though no letter between them survives.',
          'Some historians think the sale never happened at all; others are less sure. Perhaps the clerk simply copied the figure twice.',
        ],
        [
          'It is not clear who ordered the warehouse burned. It is possible that nobody did, and that the fire began in the bakery next door.',
          'It is not known whether he was ever paid. It was, at least, promised to him in writing by the council.',
          'According to one account the ship sank with all hands; another says most of the crew reached the shore. Neither can be checked.',
        ],
      ),
    );
    expect(signals).toEqual([]);
    expect(act).toEqual([]);
    expect(summary.score).toBe(0);
  });
});

// ── The score ────────────────────────────────────────────────────────────────

describe('the fingerprint score', () => {
  const plain = [
    'The bank opened in 1857 with a capital of two hundred thousand dollars.',
    'Its directors were three merchants and a retired judge from the county.',
    'Within a year it held the savings of most of the farmers in the valley.',
    'In the spring of 1860 the price of wheat fell by almost half.',
    'The farmers stopped paying their loans, and the directors stopped paying interest.',
    'The bank closed its doors in October.',
  ];
  const habits = ['Incredibly, the bank opened in 1857 with a capital of two hundred thousand dollars.', 'And then the farmers stopped paying their loans.', 'The bank was a house of cards.'];
  const withHabits = (n: number) => one([...habits.slice(0, n), ...plain.slice(n)].join(' '));

  it('rises with every signal and stays within 0–100', () => {
    const scores = [0, 1, 2, 3].map((n) => summarise(withHabits(n)).score);
    // Six sentences each time: every HARD signal adds 3 / (6 × 1.5) of the scale. The one same-length run of the plain text is below its threshold and counts nothing.
    expect(scores).toEqual([0, 33, 67, 100]);
    expect(aiSignals(withHabits(0)).map((s) => [s.pattern, s.kind])).toEqual([['length_repetition', 'DENSITY']]);
    // Every sentence a habit, several times over: capped at 100.
    expect(summarise(one('And then, little did they know, it was destiny. And then it was a house of cards. Imagine.')).score).toBe(100);
  });

  it('counts only what an editor should act on, but tallies every signal per pattern', () => {
    const blocks = film(["It wasn't a strike. It was a lockout. Incredibly, the owners won.", 'Who paid for it? The town did, for a decade.']);
    const signals = aiSignals(blocks);
    const summary = summarise(blocks, signals);
    expect(summary.perPattern).toEqual({ contrast_formula: 1, hype_adverb: 1, rhetorical_question: 1 });
    expect(summary.signals).toBe(1);
    expect(summary.overThreshold).toEqual(['hype_adverb']);
    expect(summary).toEqual(summarise(blocks));
  });

  it('counts the narrator\'s words only: quotations and speakers are left out', () => {
    const blocks = [block('1.1', 'The mayor wrote, "We shall not pay a single stiver more," and he did not.'), block('1.2', 'We paid every guilder we had.', { speakerId: 'F2' })];
    // "The mayor wrote" + "and he did not": the quotation counts as no words.
    expect(summarise(blocks).words).toBe(7);
  });

  it('is zero for an empty script', () => {
    expect(summarise([])).toEqual({ score: 0, words: 0, signals: 0, perPattern: {}, overThreshold: [] });
  });
});

// ── Block patterns and the stock lexicon ─────────────────────────────────────

describe('blockPatterns and the stock lexicon', () => {
  it('lists the patterns of one block once each, sorted', () => {
    expect(blockPatterns(block('1.1', 'Incredibly, the bridge held. And then the river rose. And then the town flooded. Little did they know.'))).toEqual([
      'dramatic_transition',
      'hype_adverb',
      'stock_phrase',
    ]);
    expect(blockPatterns(block('1.1', 'The bridge held until the spring floods of 1740.'))).toEqual([]);
  });

  it('every stock phrase is lower case and is caught whatever its capitals or typographic apostrophes', () => {
    for (const phrase of STOCK_PHRASES) {
      expect(phrase, phrase).toBe(phrase.toLowerCase());
      const typeset = phrase.replace(/'/g, '’');
      const sentence = `${typeset[0]!.toUpperCase()}${typeset.slice(1)}, according to the second narrator.`;
      expect(of(aiSignals(one(sentence)), 'stock_phrase').map((s) => s.excerpt), sentence).toContain(phrase);
    }
  });

  it('every pattern of the contract has a detector', () => {
    // A Record over AiPattern: a pattern added to the contract without an example here fails to compile.
    const EXAMPLES: Record<AiPattern, NarrationBlock[]> = {
      stock_phrase: one('Little did they know what the auditors would find.'),
      dramatic_transition: one('And then the bank failed.'),
      hype_adverb: one('Incredibly, nobody was hurt.'),
      imagine_opener: one('Imagine a city without clean water.'),
      trailer_language: one('It was destiny.'),
      mystery_language: one('The deal was shrouded in mystery.'),
      emotion_explained: one('A palpable sense of dread filled the room.'),
      truth_reveal: one("Here's the thing: nobody checked the books."),
      micro_hook: one('The council approved the new tolls in March. But not for long.'),
      contrast_formula: one("It wasn't a strike. It was a lockout."),
      qa_pair: one('The result? Chaos.'),
      fragment_run: one('Production slowed. Wages fell. Strikes began.'),
      em_dash: one('The cost was high — far higher than the partners expected — and the bank knew it.'),
      metaphor_stack: one('The settlement was a house of cards.'),
      rhetorical_question: one('Who paid for the bridge? The council records do not say.'),
      repeated_ending: film(['The first well was dug in 1902. It failed.', 'A second crew drilled deeper that summer. It failed too.', 'The investors sent an engineer from the coast. He gave up.']),
      length_repetition: one('The harbour master wrote to the city council every week. The council sent him back the same reply each time. The merchants began to borrow money against their next cargo. The banks lent them the money at a very high rate.'),
      visual_description: one('She nods.'),
    };
    for (const pattern of AI_PATTERNS) expect(patternsOf(aiSignals(EXAMPLES[pattern])), pattern).toContain(pattern);
  });

  it('signals point at the block they were found in', () => {
    const signals = aiSignals(film(['The guild met twice that year.', 'Incredibly, it voted to dissolve itself.'], ['And then the market collapsed.']));
    expect(signals.map((s) => [s.ref, s.pattern])).toEqual([
      ['1.2', 'hype_adverb'],
      ['2.1', 'dramatic_transition'],
    ]);
  });
});
