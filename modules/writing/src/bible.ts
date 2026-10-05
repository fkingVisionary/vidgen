/**
 * The house style bible: the editorial constitution every narration pass
 * works to. The source of truth is this file (versioned); STYLE_BIBLE.md in
 * the corpus is generated from it (`pnpm --filter @docengine/writing
 * corpus:docs`) and a test keeps the two in step. Generic on purpose: no
 * subject, era, name or number of any particular documentary appears here.
 */

export const STYLE_BIBLE_VERSION = 'style-bible-1.0';

export interface BibleSection {
  title: string;
  /** One line under the title. */
  lead?: string;
  rules: string[];
}

export const STYLE_BIBLE: BibleSection[] = [
  {
    title: 'Voice',
    lead: 'Intelligent. Calm. Confident. Curious. Historically grounded. Conversational. Occasionally cinematic. Never theatrically desperate.',
    rules: [
      'One narrator, telling one intelligent listener what happened — a person, not a trailer, a lecture or a news bulletin.',
      'Dry humour where the history earns it; never jokes at the expense of the people in the story.',
      'Sceptical when the evidence calls for it, and comfortable saying so.',
    ],
  },
  {
    title: 'The audience',
    lead: 'The narrator assumes the audience is intelligent.',
    rules: [
      'Explain. Don’t lecture.',
      'Reveal. Don’t keep announcing that something is about to be revealed.',
      'Trust. Don’t tell the listener what to feel, or how interesting something is: the facts create the drama.',
      'Never: “Incredibly…”, “Little did they know…”, “But what happened next…”, “And this is where everything changed.” — unless the evidence shows a genuine turning point, and then say what turned.',
    ],
  },
  {
    title: 'Four questions, kept apart',
    rules: [
      'What is historically true — decided by the research and its verdicts, never by the writing.',
      'What is useful to say — every paragraph gives the listener something: a new fact, chronology, context, a consequence, an interpretation, a character, tension, a clarification, uncertainty or a payoff. A paragraph that does none of these goes.',
      'What sounds natural spoken aloud — breath, emphasis, numbers a listener can hold, sentences that resolve.',
      'What the audience can simply see — left to the pictures.',
    ],
  },
  {
    title: 'Writing for the ear',
    rules: [
      'This is narration: not an essay, not a screenplay, not a short story. A line that looks impressive on a page but sounds awkward aloud is a failure.',
      'One idea per sentence. Sentences vary because the ideas vary: short for a turn or a number that matters, longer for context that connects. Never a run of fragments; never a sentence of five clauses.',
      'Conversational syntax: no colons, semicolons, parentheses or “respectively”; no lists of four things in one breath; references a listener can resolve without rewinding.',
      'One number per breath, and a number arrives with what it meant.',
      'Repeat on purpose — a callback, a refrain, an escalation used once — never by habit.',
    ],
  },
  {
    title: 'Narration and pictures',
    rules: [
      'Narration carries facts, context, causes, chronology, interpretation and uncertainty.',
      'Pictures carry movement, places, objects, faces, atmosphere, maps and documents. Don’t narrate what the viewer can already see: no glances, gestures, flickering candles or furniture that shrugs.',
      'Both may carry the big turns and the emotional moments.',
      'A block’s visual direction stays in its visual layer; narration never contains directions, labels or brackets.',
    ],
  },
  {
    title: 'Money and numbers',
    rules: [
      'A sum of money means something only beside what money meant at the time. Prefer, in order: a contemporary wage, an income, a household expense, an asset. A modern purchasing-power estimate is the last resort, said as approximate, and only when the evidence gives one.',
      'Never invent a comparison, an exchange rate or a modern conversion. When the evidence gives no comparison, say so plainly — “The surviving records don’t give us a reliable equivalent.” — or let the sum stand.',
      'A comparison worked out from two documented figures says “about” and keeps the weaker claim’s uncertainty.',
      'Numbers arrive as moments in a sequence and are followed by what they did to people, not by a summary of the change.',
    ],
  },
  {
    title: 'Names',
    rules: [
      'A historical name stays as the evidence spells it — in the narration, subtitles, citations and on-screen text. Never westernised because it is hard to say.',
      'How a name is spoken is a separate decision, made in the pronunciation list and approved by a person; the writing never guesses phonemes.',
      'Introduce a person by what they do the first time they are named; one new name at a time.',
    ],
  },
  {
    title: 'What we know, and how well',
    rules: [
      'Known — said plainly (“The price reached…”).',
      'Reported — attributed (“One contemporary account describes…”).',
      'Likely — hedged (“The evidence suggests…”).',
      'Uncertain — admitted (“We can’t know exactly…”).',
      'Disputed — contested (“Historians disagree…”). A legend is told as the version people tell, then tested against the record.',
      'Keep each claim at its level: never flatten uncertainty into confident prose, and never make a doubt into a disclaimer — say it the way a curious person would.',
    ],
  },
  {
    title: 'Keep what is good',
    rules: [
      'Human writing is not flat writing. A memorable line survives: a short, surprising contrast can be excellent once — the problem is a structure used again and again.',
      'An editorial pass changes what is weak and leaves what works word for word. Rewording a strong line into a safer one is a loss.',
      'Don’t make it boring: hooks, tension, curiosity, memorable lines, surprise, humour where the history allows, progression and payoff — arising from the story, never bolted on.',
    ],
  },
  {
    title: 'Machine habits to avoid',
    lead: 'Signals, not rules: each can be right once. Repeated, they make narration sound generated.',
    rules: [
      'Fake dramatic beats: “And then…”, “That’s when…”, “But this was only the beginning…”, “Everything was about to change…”.',
      'Hype adverbs (“Incredibly,”), trailer language (“destiny”, “forever”), generic mystery (“shrouded in mystery”), explained emotion (“a palpable sense of dread”).',
      'Openers that stall: “Imagine…”, an unneeded “What if…”, “The truth is…”, “Here’s the thing”.',
      'Formulas: “not X, but Y” again and again; a question answered at once by a fragment (“The result? Chaos.”); runs of fragments; em-dashes instead of sentences; stacked metaphors; every block ending on a tease.',
      'Rhythm on autopilot: sentence after sentence of the same length, the same opening, the same ending.',
    ],
  },
  {
    title: 'Delivery',
    rules: [
      'Delivery marks — curious, quiet, measured, urgent, reflective — belong to the delivery layer, where the delivery genuinely changes, and sparingly. Most blocks have none.',
      'A writing problem is fixed in the writing, never with a performance direction.',
    ],
  },
  {
    title: 'Length',
    rules: [
      'Never inflate or shrink a script to hit a word count. Priorities: story value, then clarity, then evidence, then spoken quality, then runtime. Runtime comes after editorial quality — and the evidence rules are never traded for anything.',
    ],
  },
];

/** The style bible as a prompt section (plain text, the same words as the document). */
export function styleBibleText(): string {
  return STYLE_BIBLE.map((s) => [`${s.title.toUpperCase()}${s.lead ? ` — ${s.lead}` : ''}`, ...s.rules.map((r) => `- ${r}`)].join('\n')).join('\n\n');
}

/** STYLE_BIBLE.md (generated). */
export function styleBibleMarkdown(): string {
  return [
    '# House style bible',
    '',
    `Version \`${STYLE_BIBLE_VERSION}\`. The permanent editorial constitution of the documentary writing engine: every narration pass is told to work to it, and the rubric and the AI-pattern diagnostics measure against it.`,
    '',
    '> Generated from `modules/writing/src/bible.ts` by `pnpm --filter @docengine/writing corpus:docs` — edit the source, not this file. A test fails when the two differ.',
    '',
    ...STYLE_BIBLE.flatMap((s) => [`## ${s.title}`, '', ...(s.lead ? [`**${s.lead}**`, ''] : []), ...s.rules.map((r) => `- ${r}`), '']),
  ].join('\n');
}
