/**
 * Text matching for the evidence rules: are a story's people and figures in
 * the evidence it cites? Deliberately simple and deterministic, so every
 * decision can be explained in a normalization note and tested.
 */

/** Lower-case, accents stripped, typographic quotes and dashes unified, whitespace collapsed. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word tokens (letters and digits) of a text. */
export function wordTokens(s: string): string[] {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// ── People ───────────────────────────────────────────────────────────────────

const NAME_PARTICLES = new Set(['van', 'de', 'der', 'den', 'von', 'la', 'le', 'du', 'di', 'da', 'het', 'ten', 'ter', 'of', 'the', 'and', 'jr', 'sr', 'st']);
const NAME_TITLES = new Set(['sir', 'lord', 'lady', 'mr', 'mrs', 'dr', 'captain', 'mayor', 'burgomaster', 'widow', 'master']);

/** Tokens that identify a person: no particles, titles or initials. */
export function nameTokens(name: string): string[] {
  return wordTokens(name).filter((t) => t.length >= 3 && !NAME_PARTICLES.has(t) && !NAME_TITLES.has(t) && !/^\d+$/.test(t));
}

/** True when a and b differ by at most one inserted, deleted or substituted letter. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (s.length === l.length) i++;
    j++;
  }
  return edits + (l.length - j) + (s.length - i) <= 1;
}

/** A searchable set of the words in some evidence. */
export class WordIndex {
  private readonly words: Set<string>;
  /** Longer words, for tolerant matching of early-modern spelling variants. */
  private readonly long: string[];

  constructor(text: string) {
    this.words = new Set(wordTokens(text));
    this.long = [...this.words].filter((w) => w.length >= 5);
  }

  has(word: string): boolean {
    if (this.words.has(word)) return true;
    return word.length >= 5 && this.long.some((w) => withinOneEdit(w, word));
  }
}

/**
 * Is this person's name in the evidence? Every identifying token must appear
 * (tolerating one letter's difference in longer tokens: early-modern spelling
 * varies, e.g. Winkel/Winckel), so an invented first name or surname added to
 * a real one is caught.
 */
export function nameGrounded(name: string, index: WordIndex): boolean {
  const tokens = nameTokens(name);
  return tokens.length > 0 && tokens.every((t) => index.has(t));
}

/** Does a text mention this person (by any identifying token of their name)? */
export function mentionsName(text: string, name: string): boolean {
  const words = new Set(wordTokens(text));
  const tokens = nameTokens(name);
  const surname = tokens.at(-1);
  return surname !== undefined && words.has(surname);
}

// ── Figures ──────────────────────────────────────────────────────────────────

const FIGURE = /\d{1,3}(?:[,.]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * Figures in a text, normalized ("5,200" and "5.200" → "5200", "1630s" →
 * "1630", "17th" → "17"). Figures below 10 are ignored: small counts are too
 * common to check and rarely the facts a viewer remembers.
 */
export function extractFigures(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(FIGURE)) {
    const raw = m[0];
    const value = /^\d{1,3}(?:[,.]\d{3})+$/.test(raw) ? raw.replace(/[,.]/g, '') : raw.replace(/,/g, '');
    const n = Number(value);
    if (!Number.isFinite(n) || n < 10) continue;
    out.add(String(n));
  }
  return [...out];
}

/** Four-digit years: checked against the whole dossier rather than a story's own claims. */
export function isYear(figure: string): boolean {
  const n = Number(figure);
  return Number.isInteger(n) && n >= 1000 && n <= 2100;
}

// ── Similarity ───────────────────────────────────────────────────────────────

export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'by', 'for', 'from', 'to', 'as', 'into', 'who', 'that', 'with', 'how', 'why', 'what', 'when', 'where', 'his', 'her', 'its', 'their', 'was', 'is']);

/** Word overlap of two titles (stop words ignored). */
export function titleSimilarity(a: string, b: string): number {
  const words = (s: string) => new Set(wordTokens(s).filter((w) => !STOP.has(w)));
  return jaccard(words(a), words(b));
}

// ── Story Engine 2.0: names, quotations and who-does-what ────────────────────

/** Sentences of a text (split at . ! ? … and line breaks). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Words of a sentence as written (case kept, possessive "'s" dropped). */
function rawWords(sentence: string): string[] {
  return [...sentence.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)].map((m) => m[0].replace(/['’]s$/u, ''));
}

/** Capitalised words that are not names: calendar, address, pronouns and film terms. */
const NOT_NAMES = new Set([
  ...['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  ...['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
  ...['christmas', 'easter', 'lent', 'advent', 'pentecost', 'god', 'lord', 'christ', 'mass'],
  ...['i', 'you', 'your', 'yours', 'he', 'she', 'it', 'we', 'they', 'his', 'her', 'its', 'our', 'their', 'one', 'someone', 'somebody', 'everyone', 'everybody', 'anyone', 'nobody', 'no-one', 'each', 'all', 'both', 'many', 'most', 'few', 'some', 'others'],
  ...['the', 'a', 'an', 'this', 'that', 'these', 'those', 'in', 'on', 'at', 'of', 'and', 'or', 'but', 'from', 'to', 'with'],
  ...['pov', 'vo', 'cgi', 'b-roll', 'ok'],
]);

/** Verbs that make a capitalised word act like a person (speech, interaction, thought, movement). */
const PERSON_VERBS = new Set(
  'says said speaks talks tells asks answers replies whispers shouts calls greets meets hands gives takes shakes buys sells trades pays signs agrees argues bargains bids offers sues helps pushes touches kisses hugs joins introduces warns convinces persuades bribes threatens accompanies thanks serves hires cheats robs attacks embraces thinks believes wonders fears hopes feels realises realizes regrets worries dreams imagines panics despairs suspects walks runs enters leaves sits stands waits watches looks turns smiles laughs nods frowns hesitates sighs shrugs grins cries weeps'.split(' '),
);

/** Words before a capitalised word that make it a person ("with Anna", "his friend Jan"). */
const PERSON_CUES = new Set('with named called friend companion neighbour neighbor wife husband son daughter brother sister cousin uncle aunt father mother apprentice servant clerk merchant trader widow master'.split(' '));

/**
 * Proper nouns in a text that the evidence does not know. A capitalised word
 * is reported when the known words (the dossier, the declared cast) do not
 * contain it and it is not a calendar word, pronoun or film term; at the start
 * of a sentence only when it acts like a person (followed by a person verb or
 * preceded by a person cue), since sentences start with capitals anyway.
 */
export function unknownProperNouns(text: string, known: { has(word: string): boolean }): string[] {
  const out = new Set<string>();
  for (const s of sentences(text)) {
    const words = rawWords(s);
    words.forEach((w, i) => {
      if (!/^\p{Lu}/u.test(w)) return;
      const lower = wordTokens(w)[0];
      // A capital followed by digits is a reference (claim C014, unit S03, question Q2, cast F1), not a name.
      if (!lower || lower.length < 3 || NOT_NAMES.has(lower) || /^\d/.test(lower) || /^\p{Lu}\d+$/u.test(w) || known.has(lower)) return;
      const next = words[i + 1]?.toLowerCase();
      const prev = words[i - 1]?.toLowerCase();
      const personLike = (next !== undefined && PERSON_VERBS.has(next)) || (prev !== undefined && PERSON_CUES.has(prev));
      if (i === 0 && !personLike) return;
      out.add(w);
    });
  }
  return [...out];
}

/** Interaction verbs (base and third-person forms): speaking to, touching, trading with. */
export const INTERACTION_VERBS = new Set(
  'speak speaks talk talks say says tell tells ask asks answer answers reply replies greet greets meet meets hand hands give gives take takes shake shakes buy buys sell sells trade trades pay pays sign signs agree agrees argue argues bargain bargains bid bids offer offers sue sues help helps push pushes touch touches kiss kisses hug hugs join joins introduce introduces warn warns convince convinces persuade persuades bribe bribes threaten threatens accompany accompanies whisper whispers shout shouts call calls thank thanks serve serves hire hires cheat cheats rob robs attack attacks embrace embraces'.split(
    ' ',
  ),
);

/** Mental verbs: an inner life a source would have to record. */
export const MENTAL_VERBS = new Set('thinks believes wonders fears hopes feels realises realizes regrets worries dreams imagines panics despairs suspects'.split(' '));

/**
 * Does a sentence have one of `subjects` immediately followed by one of
 * `verbs`, with one of `objects` after it in the same sentence? Tokens are
 * normalized words (a person's identifying token, or "you"/"your" for the
 * viewer). With no objects, the subject and verb alone are enough.
 */
export function subjectVerbObject(text: string, subjects: readonly string[], verbs: ReadonlySet<string>, objects: readonly string[] = []): boolean {
  if (subjects.length === 0) return false;
  for (const s of sentences(text)) {
    const words = wordTokens(s);
    for (let i = 0; i < words.length - 1; i++) {
      if (!subjects.includes(words[i]!) || !verbs.has(words[i + 1]!)) continue;
      if (objects.length === 0) return true;
      // The object belongs to the same clause: "pays Bol while you watch" is not an interaction with "you".
      for (const w of words.slice(i + 2)) {
        if (CLAUSE_BREAKS.has(w)) break;
        if (objects.includes(w)) return true;
      }
    }
  }
  return false;
}

const CLAUSE_BREAKS = new Set(['while', 'as', 'and', 'but', 'when', 'then', 'because', 'who', 'which', 'that', 'whereas', 'although', 'though', 'before', 'after', 'until', 'so', 'or']);

/** Passages in quotation marks of at least `minWords` words. */
export function quotedPassages(text: string, minWords = 3): string[] {
  return [...text.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]!.trim()).filter((q) => wordTokens(q).length >= minWords);
}

/** A quotation reduced to its words, for comparing it with a source's wording. */
export function quoteWords(s: string): string {
  return wordTokens(s).join(' ');
}

/** Is `quote` (or each part between ellipses) found word for word in `source`? */
export function quoteFoundIn(quote: string, source: string): boolean {
  const hay = ` ${quoteWords(source)} `;
  const parts = quote
    .split(/\.\.\.|…/)
    .map(quoteWords)
    .filter((p) => p.split(' ').length >= 2);
  return parts.length > 0 && parts.every((p) => hay.includes(` ${p} `));
}
