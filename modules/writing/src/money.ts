import { PRESENTATION_FOR_VERDICT, type ClaimVerdict, type ConfidenceLevel, type HistoricalMoneyContext, type MoneyComparisonType, type MoneyGap } from '@docengine/core';
import { normalize, sentences, type EvidenceBase } from '@docengine/story/shared';
import { maskQuotes, narrationOnly, type NarrationBlock } from './text.ts';

/**
 * Historical money context: what a sum meant to the people who paid it —
 * from the evidence only. The comparisons come from the claims an approved
 * architecture cites (a price and, in order of preference, a contemporary
 * wage, an income, a household expense, an asset; a modern estimate last
 * and only when the evidence itself gives one). Nothing is invented: no
 * exchange rates, no modern conversions, no assumed working year. When the
 * evidence has no comparison, there is no context — and the gap is said.
 */

export const NO_EQUIVALENT = "The surviving records don't give us a reliable equivalent.";

/** Currencies the engine knows without being told (the dossier's own price evidence adds its currencies). */
const BASE_CURRENCIES = [
  'pound', 'shilling', 'penny', 'pence', 'guinea', 'dollar', 'cent', 'franc', 'livre', 'sou', 'sous', 'ducat', 'florin', 'crown',
  'mark', 'lira', 'lire', 'real', 'reales', 'peso', 'thaler', 'kreuzer', 'rupee', 'yen', 'rouble', 'ruble', 'denarius', 'denarii', 'sesterce',
  'sestertius', 'drachma', 'talent', 'euro', 'escudo', 'doubloon', 'piastre', 'kopeck', 'groat', 'farthing',
];
const SYMBOL: Record<string, string> = { '£': 'pound', $: 'dollar', '€': 'euro', '¥': 'yen' };

const singular = (w: string) => {
  const x = w.toLowerCase();
  if (x === 'pence' || x === 'sous' || x === 'lire' || x === 'reales' || x === 'denarii') return x;
  if (x.endsWith('ies')) return `${x.slice(0, -3)}y`;
  return x.endsWith('s') && x.length > 3 ? x.slice(0, -1) : x;
};

const IRREGULAR_PLURAL: Record<string, string> = { penny: 'pence', denarius: 'denarii', real: 'reales', lira: 'lire', sou: 'sous', pence: 'pence', sous: 'sous', lire: 'lire', reales: 'reales', denarii: 'denarii', yen: 'yen' };

/** A currency as said with an amount ("1,200 crowns", "1 pound", "300 pence"). */
export function unitFor(currency: string, amount: number): string {
  if (amount === 1) return currency;
  return IRREGULAR_PLURAL[currency] ?? (currency.endsWith('y') ? `${currency.slice(0, -1)}ies` : `${currency}s`);
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALE: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000 };

/**
 * "1,200" → 1200; "twelve hundred" → 1200; "three thousand" → 3000; "a hundred" → 100; "40 million" → 40000000.
 * Two sums are not one: "two hundred and three hundred" or "one thousand and two thousand" → null.
 */
export function parseAmount(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (/^\d/.test(t)) {
    const [digits, ...scales] = t.split(/[\s-]+/);
    let n = Number(digits!.replace(/,/g, ''));
    for (const w of scales) {
      if (!(w in SCALE)) return null;
      n *= SCALE[w]!;
    }
    return Number.isFinite(n) ? n : null;
  }
  let total = 0;
  let current = 0;
  let hundred = false; // the group being read already has its "hundred"
  let last = Infinity; // the scale of the last group added to the total
  let seen = false;
  for (const w of t.split(/[\s-]+/)) {
    if (w === 'and') continue;
    if (w in NUMBER_WORDS) {
      current += NUMBER_WORDS[w]!;
      seen = true;
    } else if (w in SCALE) {
      const scale = SCALE[w]!;
      seen = true;
      if (scale < 1000) {
        if (hundred) return null;
        current = (current || 1) * scale;
        hundred = true;
      } else if (scale < last) {
        total += (current || 1) * scale;
        current = 0;
        hundred = false;
        last = scale;
      } else if (!current) {
        total *= scale; // "ten thousand million"
        last = scale;
      } else return null;
    } else return null;
  }
  return seen ? total + current : null;
}

export interface MoneyMention {
  amount: number;
  amountText: string;
  currency: string;
  /** The sentence it is in. */
  sentence: string;
}

const UNITS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const SCALES = 'hundred|thousand|million|billion';
/** Digits, with any scale word after them ("1,200", "40 million"). */
const DIGITS = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:[\s-]+(?:${SCALES})\b)*`;
/** A sum in words, read whole: "twenty-five", "twelve hundred", "a thousand", "two thousand five hundred", "one hundred and fifty". */
const WORDS = String.raw`(?:(?:a|an)(?=[\s-]+(?:${SCALES})\b)|(?:${UNITS}|${SCALES})\b)(?:(?:[\s-]+|(?<=(?:${SCALES}))\s+and\s+)(?:${UNITS}|${SCALES})\b)*`;
const NUM = `${DIGITS}|${WORDS}`;

/** The sum a run of number words ends with: "between two hundred and three hundred" is two sums, and the currency after them is the last one's. */
function lastSum(text: string): { text: string; amount: number } | null {
  const amount = parseAmount(text);
  if (amount !== null) return { text, amount };
  const and = /\s+and\s+/i.exec(text);
  return and ? lastSum(text.slice(and.index + and[0].length)) : null;
}

/** A sum where it stands in its sentence: from its amount (or symbol) to the end of its currency word. */
interface PlacedSum {
  mention: MoneyMention;
  start: number;
  end: number;
}

/** A scale written straight after a symbol amount: "£3m", "$1.5bn", "€40k". */
const SUFFIX: Record<string, number> = { k: 1_000, m: 1_000_000, mn: 1_000_000, bn: 1_000_000_000 };
/** Currencies that are weights as well: a sum of them "of" something is a weight ("500 pounds of nutmeg") unless the something is money. */
const WEIGHT = new Set(['pound', 'livre', 'mark', 'talent']);
const OF_SOMETHING = /^\s+of\b/i;
const OF_MONEY = /^\s+of\s+(?:debts?|credit|capital|stock|money|cash|profits?|loss(?:es)?|tax(?:es)?|income|revenues?|savings|sterling)\b/i;
/** A year before a currency word that is also a verb: "1720 marks the peak" is a date, not a sum — unless the sentence pays it ("earned 1500 crowns a year"). */
const YEAR_VERB = /^(?:marks|crowns|pounds)\s+(?:the|a|an|its|his|her|their|this|that|one)\b/i;
const PAYS = /\b(?:cost|costs|price|priced|paid|pay|pays|earn(?:ed|s|t)?|wages?|salary|income|worth|valued|sold|bought|fetched|spent|owed|lent|borrowed|fined?|rent)\b/i;
/** The shillings or pence after pounds (or the pence after shillings) of one sum: "£2 10s", "2 pounds 10 shillings", "5 shillings and 6 pence". */
const SUBUNIT: Record<string, RegExp> = {
  pound: new RegExp(String.raw`^,?\s+(?:and\s+)?(?:\d+\s?[sd]\b\.?|(?:${NUM})\s+(?:shillings?|pence|penny)\b)`, 'i'),
  shilling: new RegExp(String.raw`^,?\s+(?:and\s+)?(?:\d+\s?d\b\.?|(?:${NUM})\s+(?:pence|penny)\b)`, 'i'),
};

/**
 * The sums of each sentence of a text, in order. A weight ("500 pounds of
 * nutmeg") or a year ("1720 marks the peak") is not a sum; nor is a part of
 * a sum in pounds, shillings and pence ("£2 10s"), which is left out whole
 * rather than read short.
 */
function sumsBySentence(text: string, currencies: ReadonlySet<string>): { sentence: string; sums: PlacedSum[] }[] {
  const words = [...currencies].flatMap((c) => [c, `${c}s`, c.endsWith('y') ? `${c.slice(0, -1)}ies` : null].filter(Boolean)).sort((a, b) => b!.length - a!.length);
  const named = new RegExp(String.raw`\b(${NUM})\s+(?:(?:gold|silver|copper|paper)\s+)?(${words.map((w) => w!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\b`, 'gi');
  const symbol = new RegExp(String.raw`([£$€¥])\s?(${DIGITS})(bn|mn|m|k)?(?![\p{L}\p{N}]|[.,]\d)`, 'giu');
  return sentences(maskQuotes(text)).map((s) => {
    const found: PlacedSum[] = [];
    for (const m of s.matchAll(named)) {
      const sum = lastSum(m[1]!);
      const currency = singular(m[2]!);
      const end = m.index + m[0].length;
      const rest = s.slice(end);
      if (!sum || (WEIGHT.has(currency) && OF_SOMETHING.test(rest) && !OF_MONEY.test(rest))) continue;
      if (/^(?:1\d{3}|20\d{2})$/.test(sum.text) && YEAR_VERB.test(s.slice(end - m[2]!.length)) && !PAYS.test(s.slice(0, m.index))) continue;
      found.push({ mention: { amount: sum.amount, amountText: sum.text, currency, sentence: s }, start: m.index + m[1]!.length - sum.text.length, end });
    }
    for (const m of s.matchAll(symbol)) {
      const amount = parseAmount(m[2]!);
      if (amount !== null) found.push({ mention: { amount: amount * (m[3] ? SUFFIX[m[3].toLowerCase()]! : 1), amountText: `${m[2]!}${m[3] ?? ''}`, currency: SYMBOL[m[1]!]!, sentence: s }, start: m.index, end: m.index + m[0].length });
    }
    const sums: PlacedSum[] = [];
    let compound = -1; // where the parts of a sum in pounds, shillings and pence end
    for (const p of found.sort((a, b) => a.start - b.start)) {
      if (sums.length && p.start < sums.at(-1)!.end) continue;
      const sub = SUBUNIT[p.mention.currency]?.exec(s.slice(p.end));
      if (sub) compound = Math.max(compound, p.end + sub[0].length);
      else if (p.start >= compound) sums.push(p);
    }
    return { sentence: s, sums };
  });
}

/** Sums of money in a text: "1,200 crowns", "£300", "three hundred pounds". */
export function moneyMentions(text: string, currencies: ReadonlySet<string>): MoneyMention[] {
  return sumsBySentence(text, currencies).flatMap((s) => s.sums.map((p) => p.mention));
}

/** Words for pay: a rate beside a person is a wage only with one of them ("paid a rent of" is not one). */
const WAGE = /\b(?:earn(?:ed|s|ing|t)?|wages?|(?:was|were|is|are|been|being) paid|paid (?:per|each|by the)|day'?s (?:work|pay|wage)|salary|stipend)\b/;
const INCOME = /\b(?:income|revenue|rents? of|yielded|annual(?:ly)?|a year'?s? income)\b/;
const HOUSEHOLD = /\b(?:bread|loaf|loaves|rent|beer|ale|meat|food|firewood|household|meal|cheese|butter|candles?|grain|wheat|rye|flour)\b/;
const ASSET = /\b(?:house|houses|home|ship|land|farm|estate|cow|horse|carriage|acres?|building|mansion|workshop|mill)\b/;
const MODERN = /\b(?:today'?s? (?:money|prices?|terms|values?|standards)|in today'?s|at today'?s|modern (?:money|terms|equivalent|prices?|values?)|present-day|equivalent today|in current|(?:adjusted|allowing|accounting) for inflation|inflation[- ]adjusted|in (?:19[5-9]\d|20\d\d) (?:money|terms|prices|values|pounds|dollars|euros))\b/;
/** A modern figure said as one, straight after the sum: "150,000 pounds today" — but "the 500 pounds now owed" is not one. */
const NOW = /^(?:today|nowadays|now(?=\W*$))\b/;
/** The period a sum is for, said straight after it: "13 pounds a year", "5 shillings weekly", "40 pounds per annum"… */
const PER = /^(?:(?:a|per|each|every) (day|week|month|year|annum)|(daily|weekly|monthly|yearly|annually))\b/;
/** …or before it, as a wage's or an income's: "a yearly wage of 13 pounds", "an annual income of 500 pounds". */
const PER_BEFORE = /\b(daily|weekly|monthly|yearly|annual) (?:[a-z]+ )?(?:wages?|pay|income|salary|stipend|earnings|allowance|pension|revenues?)\b/;
const PERIOD_OF: Record<string, 'day' | 'week' | 'month' | 'year'> = { day: 'day', daily: 'day', week: 'week', weekly: 'week', month: 'month', monthly: 'month', year: 'year', yearly: 'year', annum: 'year', annual: 'year', annually: 'year' };
const TOTAL = /\b(?:total|in all|altogether|all together|the whole|combined|raised|proceeds|takings|turnover|receipts|brought in|sales|debts?|owed|losses)\b/;
/** A number of things ("the 99 lots", "40 barrels", "all the shares"): what they fetched together is a total. A span of time, a year, what something comes "with" or a word that only ends in "s" ("ten times its price") is not. */
const NOT_THINGS = String.raw`(?:years|months|weeks|days|hours|minutes|decades|centuries|times|generations|its|his|hers|this|thus|was|has|is|as|us|less|unless|perhaps|whereas)\b`;
const COUNTED = new RegExp(
  String.raw`(?<!\bwith )\b(?:(?!1\d{3}\b|20\d{2}\b)\d[\d,]*|(?!one\b)(?:${UNITS})|hundreds|thousands|dozens|several|many|all (?:the|his|her|their|its)) (?:of (?:the )?)?(?:(?!${NOT_THINGS})[a-z-]+ )?(?!${NOT_THINGS})[a-z]+s\b`,
);
const WHO = /\b((?:a|an|the|one) (?:\w+ ){0,2}(?:craftsman|craftsmen|labourer|laborer|worker|carpenter|weaver|sailor|servant|clerk|soldier|artisan|maid|apprentice|mason|teacher|smith|blacksmith|baker|farmhand|shipwright|miner|journeyman|tradesman|official|priest|schoolmaster|seaman|docker|porter|driver|nurse|cook))\b/;
const WHO_ALL = new RegExp(WHO.source, 'g');
/** A number on its own ("20", "twenty", not a year): an "and" or "or" between two is a range ("between 20 and 25 pounds"), not two clauses. */
const BARE = String.raw`(?:\b(?!(?:1\d{3}|20\d{2})\b)\d[\d,.]*|\b(?:${UNITS}|${SCALES})\b)`;
/** Where a clause ends: punctuation (not the comma of "1,500"), or a word that joins two clauses ("…5 shillings a week, or 13 pounds a year", "…20 pounds a year and a carpenter 40") — not the "and" of a range or the "than" of "more than 20 pounds". */
const BOUNDARY = new RegExp(
  String.raw`(?<!\d),|,(?!\d)|[;:()[\]—–]|\s-\s|\b(?:but|while|whilst|whereas|when|compared|against|versus)\b|\b(?:and|or)\b(?<!${BARE}\s+(?:and|or))|\b(?:and|or)\b(?!\s+(?:[£$€¥]|${BARE}))|\bthan\b(?<!\b(?:more|less|fewer)\s+than)`,
  'gi',
);
/** Words a clause may have besides a person and still borrow the verb of the clause before it ("…and a master carpenter about 40 pounds a year"). */
const HEDGE = /\b(?:about|around|roughly|some|nearly|almost|over|under|only|just|perhaps|at least|up to|(?:no )?(?:more|less) than|as (?:much|little) as)\b/g;

type Period = 'day' | 'week' | 'month' | 'year' | null;

interface MoneyFact extends MoneyMention {
  claimKey: string;
  verdict: ClaimVerdict;
  confidence: ConfidenceLevel;
  /** What the sum is; null when that cannot be told (a rate beside a person with no word for pay or cost, pay with two people it may be for, or a sentence with a modern figure that may be this one). */
  kind: MoneyComparisonType | 'PRICE' | null;
  period: Period;
  total: boolean;
  year: number | null;
  item: string | null;
  who: string | null;
}

const VERDICT_WEAKNESS: Record<ClaimVerdict, number> = { ESTABLISHED: 0, PROBABLE: 1, DISPUTED: 2, UNVERIFIED: 3, MYTH: 4 };
const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const VERDICT_CONFIDENCE: Record<ClaimVerdict, ConfidenceLevel> = { ESTABLISHED: 'HIGH', PROBABLE: 'MEDIUM', DISPUTED: 'LOW', UNVERIFIED: 'LOW', MYTH: 'LOW' };
const weakest = <T extends string>(xs: readonly T[], rank: Record<T, number>): T => [...xs].sort((a, b) => rank[b] - rank[a])[0]!;

const yearIn = (s: string | null | undefined): number | null => {
  const m = /\b(1[0-9]{3}|20[0-9]{2})s?\b/.exec(s ?? '');
  return m ? Number(m[1]) : null;
};

/** The words of a text, the first or the last few. */
const firstWords = (s: string, n: number) => s.split(' ').filter(Boolean).slice(0, n).join(' ');
const lastWords = (s: string, n: number) => s.split(' ').filter(Boolean).slice(-n).join(' ');

/** A sentence with some stretches of it cut out (each left as a break, so no two words are joined). */
function without(sentence: string, ranges: readonly (readonly [number, number])[]): string {
  let out = '';
  let at = 0;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    out += `${sentence.slice(at, from)} ; `;
    at = Math.max(at, to);
  }
  return out + sentence.slice(at);
}

/** What a sentence says around one of its sums (each normalized). */
interface SumWords {
  /** The sum as written, with its currency word. */
  sum: string;
  /** Its own clause: the words since the last clause break (or other sum) before it… */
  head: string;
  /** …and after its currency word up to the first one after it. */
  tail: string;
  /** The words since the sum before it (or the start of the sentence): where the person whose sum it is is named. */
  since: string;
  /** The sentence without the other sums' clauses or the sum itself: a word that speaks for the whole sentence ("altogether", "in today's money") is read here. */
  rest: string;
}

/** Each sum of a sentence with the words that are its own: what one sum's clause says is never read as another's. */
function sumWords(sentence: string, sums: readonly PlacedSum[]): SumWords[] {
  // Read in the whole sentence: whether an "and" is a range's turns on the number after it.
  const breaks = [...sentence.matchAll(BOUNDARY)].map((b) => [b.index, b.index + b[0].length] as const);
  const clauses = sums.map((p, i): [number, number, number] => {
    const from = i ? sums[i - 1]!.end : 0;
    const to = i < sums.length - 1 ? sums[i + 1]!.start : sentence.length;
    const last = breaks.filter(([a, b]) => a >= from && b <= p.start).at(-1);
    const first = breaks.find(([a, b]) => a >= p.end && b <= to);
    return [last ? last[1] : from, first ? first[0] : to, from];
  });
  return sums.map((p, i) => {
    const [headStart, tailEnd, from] = clauses[i]!;
    const others = clauses.filter((_, j) => j !== i).map(([a, b]) => [a, b] as const);
    return {
      sum: normalize(sentence.slice(p.start, p.end)),
      head: normalize(sentence.slice(headStart, p.start)),
      tail: normalize(sentence.slice(p.end, tailEnd)),
      since: normalize(sentence.slice(from, p.start)),
      rest: normalize(without(sentence, [...others, [p.start, p.end]])),
    };
  });
}

/**
 * Whose a sum is: the person named in its own clause, or else since the sum
 * before it, or else just after it ("20 pounds a year for a labourer"). Two
 * people named there ("a carpenter who trained a labourer earned…") and it
 * cannot be told.
 */
function whose({ head, since, tail }: SumWords): { who: string | null; unsure: boolean } {
  for (const words of [head, since]) {
    const named = [...words.matchAll(WHO_ALL)].map((m) => m[1]!);
    if (named.length) return new Set(named.map((n) => n.split(' ').at(-1))).size === 1 ? { who: named[0]!, unsure: false } : { who: null, unsure: true };
  }
  return { who: WHO.exec(tail)?.[1] ?? null, unsure: false };
}

function classify(text: string): MoneyComparisonType | 'PRICE' {
  const s = normalize(text);
  if (MODERN.test(s)) return 'MODERN_ESTIMATE';
  if (WAGE.test(s)) return 'CONTEMPORARY_WAGE';
  // A cost before an income: "an annual rent", "a rent of" is spent, not earned.
  if (HOUSEHOLD.test(s)) return 'HOUSEHOLD_EXPENSE';
  if (INCOME.test(s)) return 'INCOME';
  if (ASSET.test(s) && !/\bfor\b/.test(s.split(/\d/)[0] ?? '')) return 'ASSET';
  return 'PRICE';
}

/** The currencies of a dossier: the engine's own list and the ones its price evidence names. */
export function currenciesOf(evidence: EvidenceBase): Set<string> {
  // The research writes the currency freely ("thalers (Imperial thalers)", "livres tournois / livres"): each named alternative's last word.
  const named = evidence.content.priceEvidence.flatMap((p) => p.currency.split(/[(),/;]|\bor\b/).map((part) => part.match(/\p{L}+/gu)?.at(-1) ?? ''));
  return new Set([...BASE_CURRENCIES, ...named.map(singular).filter((c) => c.length > 1)]);
}

/**
 * Every sum of money the cited claims state, with what it is (a price, a
 * wage, an income…), each read from its own clause: the period a wage is
 * for is the one said with it, the person is the one named nearest it, and
 * a rate beside a person with no word for pay is not taken for a wage.
 */
export function moneyFacts(evidence: EvidenceBase, claimSet: ReadonlySet<string>): MoneyFact[] {
  const currencies = currenciesOf(evidence);
  const out: MoneyFact[] = [];
  const seen = new Set<string>();
  for (const key of claimSet) {
    const c = evidence.claim(key);
    if (!c) continue;
    const texts = [c.statement, ...evidence.verifiedQuotes(key)];
    for (const t of texts) {
      for (const { sentence, sums } of sumsBySentence(t, currencies)) {
        const read: Pick<MoneyFact, 'kind' | 'period' | 'who'>[] = [];
        sumWords(sentence, sums).forEach((words, i) => {
          const { sum, head, tail, rest } = words;
          const m = sums[i]!.mention;
          const own = `${head} ${sum} ${tail}`;
          const price = evidence.content.priceEvidence.find((p) => p.claimKeys.includes(key) && parseAmount(p.price) === m.amount);
          const priced = normalize(`${price?.item ?? ''} ; ${price?.context ?? ''}`);
          const period = PERIOD_OF[PER.exec(tail)?.slice(1).find(Boolean) ?? ''] ?? PERIOD_OF[PER_BEFORE.exec(lastWords(head, 6))?.[1] ?? ''] ?? null;
          let kind: MoneyFact['kind'] = MODERN.test(own) || NOW.test(tail) ? 'MODERN_ESTIMATE' : MODERN.test(rest) ? null : price ? classify(`${price.item} ${price.context}`) : classify(`${lastWords(head, 6)} ${sum} ${firstWords(tail, 6)}`);
          let { who, unsure } = whose(words);
          const before = read[i - 1];
          if (kind === 'PRICE' && !price && period) {
            // "…20 pounds a year and a master carpenter 40 pounds a year": a clause with no verb of its own shares the one before it.
            const shared = (before?.kind === 'CONTEMPORARY_WAGE' || before?.kind === 'INCOME') && before.period && !head.replace(WHO_ALL, ' ').replace(HEDGE, ' ').trim();
            kind = shared ? before.kind : who || unsure ? null : 'PRICE';
            if (shared) who ??= before.who;
          }
          // Pay whose it is cannot be told is no one's to set a price beside.
          if (unsure && (kind === 'CONTEMPORARY_WAGE' || kind === 'INCOME')) kind = null;
          read.push({ kind, period, who });
          const id = `${key}|${m.amount}|${m.currency}`;
          if (seen.has(id)) return;
          seen.add(id);
          out.push({
            ...m,
            claimKey: key,
            verdict: c.verdict,
            confidence: c.confidence,
            kind,
            period,
            total: [own, rest, priced].some((x) => TOTAL.test(x)) || [head, tail, rest, priced].some((x) => COUNTED.test(x)),
            year: yearIn(price?.date) ?? yearIn(m.sentence) ?? yearIn(c.statement),
            item: price?.item ?? null,
            who,
          });
        });
      }
    }
  }
  return out;
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function words(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
  return String(n);
}

/**
 * A ratio as a narrator would say it: "about four", "nearly five", "more
 * than twenty". "Nearly" only a little below the number said (within a
 * tenth of it); otherwise "more than" the number below — 2.5 is "more than
 * two", never "nearly three" — and "less than one" under one.
 */
export function spokenRatio(r: number): { phrase: string; value: number } {
  const step = r >= 20 ? 5 : 1;
  const rounded = Math.max(step, Math.round(r / step) * step);
  if (Math.abs(r - rounded) < 0.15) return { phrase: `about ${words(rounded)}`, value: rounded };
  if (r < rounded && rounded - r < rounded / 10) return { phrase: `nearly ${words(rounded)}`, value: rounded };
  if (r < 1) return { phrase: 'less than one', value: 1 };
  const below = Math.floor(r / step) * step;
  return { phrase: `more than ${words(below)}`, value: below };
}

/** What a comparison given in the evidence's own words is. */
const COMPARED: Record<MoneyComparisonType, string> = { CONTEMPORARY_WAGE: 'a wage', INCOME: 'an income', HOUSEHOLD_EXPENSE: 'a household expense', ASSET: 'an asset', MODERN_ESTIMATE: 'a modern estimate' };
const PLURAL: Record<'day' | 'week' | 'month' | 'year', string> = { day: "days'", week: "weeks'", month: "months'", year: "years'" };
const SINGULAR: Record<'day' | 'week' | 'month' | 'year', string> = { day: "a day's", week: "a week's", month: "a month's", year: "a year's" };

/**
 * The money contexts the evidence supports, for the prices it states. A
 * price is set beside a comparison in the same currency, from the same era
 * (within 25 years when both are dated), never a total beside a wage. A wage
 * or income with a period, and not a total, gives a ratio a narrator can say
 * ("about four years' pay for a skilled craftsman"); any other comparison is
 * given in the evidence's own words. Each context rests on both claims and takes the
 * weaker verdict, which decides how it must be worded.
 */
export function moneyContexts(evidence: EvidenceBase, claimSet: ReadonlySet<string>): HistoricalMoneyContext[] {
  const facts = moneyFacts(evidence, claimSet);
  const prices = facts.filter((f) => f.kind === 'PRICE');
  const comparisons = facts.filter((f) => f.kind !== 'PRICE' && f.kind !== null);
  const order: MoneyComparisonType[] = ['CONTEMPORARY_WAGE', 'INCOME', 'HOUSEHOLD_EXPENSE', 'ASSET', 'MODERN_ESTIMATE'];
  const out: HistoricalMoneyContext[] = [];
  for (const p of prices) {
    const candidates = comparisons
      // A modern estimate only when the evidence gives one for this very sum (in its own sentence); any other comparison in the same currency.
      .filter((r) => (r.kind === 'MODERN_ESTIMATE' ? r.sentence === p.sentence : r.currency === p.currency && r !== p))
      .filter((r) => !(p.year && r.year && Math.abs(p.year - r.year) > 25))
      .filter((r) => !(p.total && (r.kind === 'CONTEMPORARY_WAGE' || r.kind === 'INCOME')))
      .sort((a, b) => order.indexOf(a.kind as MoneyComparisonType) - order.indexOf(b.kind as MoneyComparisonType) || Math.abs((p.year ?? 0) - (a.year ?? 0)) - Math.abs((p.year ?? 0) - (b.year ?? 0)));
    for (const r of candidates.slice(0, 2)) {
      const kind = r.kind as MoneyComparisonType;
      const verdict = weakest([p.verdict, r.verdict], VERDICT_WEAKNESS);
      const confidence = weakest([p.confidence, r.confidence, VERDICT_CONFIDENCE[verdict]], CONFIDENCE_RANK);
      const periodic = (kind === 'CONTEMPORARY_WAGE' || kind === 'INCOME') && r.period && r.amount > 0 && !r.total;
      let ratio: number | null = null;
      let explanation: string;
      let methodology: string;
      const who = r.who ? ` for ${r.who}` : '';
      if (periodic) {
        ratio = Math.round((p.amount / r.amount) * 100) / 100;
        const period = r.period!;
        const s = spokenRatio(ratio);
        if (ratio < 0.75) explanation = `a fraction of ${SINGULAR[period]} pay${who}`;
        else if (s.value > 1) explanation = `${s.phrase} ${PLURAL[period]} pay${who}`;
        // One period's pay, said by the same rule: "about a year's", "nearly a year's", "more than a year's" — and below it, "most of a year's".
        else explanation = `${s.phrase === 'less than one' ? 'most of' : s.phrase.replace(/ one$/, '')} ${SINGULAR[period]} pay${who}`;
        methodology = `${p.claimKey} gives ${p.amountText} ${unitFor(p.currency, p.amount)}${p.item ? ` (${p.item})` : ''}; ${r.claimKey} gives ${r.amountText} ${unitFor(r.currency, r.amount)} a ${period}${who}: ${p.amount} ÷ ${r.amount} = ${ratio}, said as "${explanation}".`;
      } else if (kind === 'MODERN_ESTIMATE') {
        explanation = r.sentence;
        methodology = `${r.claimKey} itself gives a modern estimate for ${p.amountText} ${unitFor(p.currency, p.amount)}: approximate, and only as the evidence words it.`;
      } else {
        explanation = `for comparison, the evidence gives: "${r.sentence}"`;
        methodology = `${p.claimKey} gives ${p.amountText} ${unitFor(p.currency, p.amount)}; ${r.claimKey} gives ${r.amountText} ${unitFor(r.currency, r.amount)} for ${COMPARED[kind]} — set side by side, no arithmetic beyond what the evidence says.`;
      }
      out.push({
        id: '',
        amount: p.amount,
        amountText: p.amountText,
        currency: p.currency,
        date: p.year ? String(p.year) : null,
        item: p.item,
        comparisonType: kind,
        comparisonValue: r.sentence,
        ratio,
        explanation,
        sourceClaimKeys: [...new Set([p.claimKey, r.claimKey])],
        verdict,
        presentation: PRESENTATION_FOR_VERDICT[verdict],
        confidence: kind === 'MODERN_ESTIMATE' ? 'LOW' : confidence,
        methodology,
        approximate: kind === 'MODERN_ESTIMATE' || ratio !== null,
      });
    }
  }
  return out
    .sort((a, b) => a.amount - b.amount || order.indexOf(a.comparisonType) - order.indexOf(b.comparisonType))
    .map((c, i) => ({ ...c, id: `M${i + 1}` }));
}

/** Words that already give a sum some meaning. (A plural possessive ends in an apostrophe, where "\b" cannot follow.) */
const CONTEXT_WORDS = /\b(?:earn(?:ed|s|t)?|wages?|pay|paid|salary|income|a (?:day|week|month|year)'?s|as much as|more than|worth|enough to buy|the price of|cost of|equal to|for comparison|records don'?t give)\b|\b(?:days|weeks|months|years)'(?!\w)/;
/** …but the same words only leading up to the sum ("agreed to pay 1,200 crowns", "worth 5,500 crowns") say nothing of what it meant — unless the sum is a rate ("paid 300 crowns a year"). */
const LEADS_TO_SUM = new RegExp(
  String.raw`\b(?:pay|paid|worth|more than|as much as|the price of|cost of|equal to)\s+(?:(?:about|around|roughly|nearly|almost|some|over|only|just|at least|more than|as much as)\s+)*(?:[£$€¥]\s?)?(?:${NUM})(?:bn|mn|m|k)?\b(?![^.;:!?]*\b(?:a|per|each|every) (?:day|week|month|year)\b)`,
  'gi',
);

export interface MoneyUse {
  ref: string;
  mention: MoneyMention;
  /** Contexts the evidence offers for this sum. */
  contexts: HistoricalMoneyContext[];
  /** The block (or the one before or after it) already says what the sum meant. */
  contextualised: boolean;
}

/** Every sum the narration says, with the context the evidence offers and whether the narration already gives it. */
export function moneyInNarration(blocks: readonly NarrationBlock[], contexts: readonly HistoricalMoneyContext[], currencies: ReadonlySet<string>): MoneyUse[] {
  const narration = narrationOnly(blocks);
  const out: MoneyUse[] = [];
  narration.forEach((b, i) => {
    for (const m of moneyMentions(b.text, currencies)) {
      const near = [narration[i - 1], b, narration[i + 1]].filter((x): x is NarrationBlock => !!x && x.section === b.section);
      const contextualised = near.some((x) => CONTEXT_WORDS.test(normalize(maskQuotes(x.text)).replace(LEADS_TO_SUM, '')));
      out.push({ ref: b.key, mention: m, contexts: contexts.filter((c) => c.amount === m.amount && c.currency === m.currency), contextualised });
    }
  });
  return out;
}

/** Sums the narration says without context and for which the evidence gives none: said plainly, never filled in. */
export function moneyGaps(uses: readonly MoneyUse[]): MoneyGap[] {
  return uses
    .filter((u) => !u.contextualised && u.contexts.length === 0)
    .map((u) => ({ ref: u.ref, amountText: u.mention.amountText, currency: u.mention.currency, note: `${NO_EQUIVALENT} (No claim the architecture cites sets ${u.mention.amountText} ${unitFor(u.mention.currency, u.mention.amount)} beside a wage, an income, a household expense or an asset.)` }));
}

/** The money context a narrator could add, rendered for a prompt (each with its claims and the wording its verdict requires). */
export function renderMoneyContexts(contexts: readonly HistoricalMoneyContext[]): string {
  if (!contexts.length) return `- none: the cited evidence sets no sum beside a wage, an income, a household expense or an asset. Where a sum needs meaning, say so plainly ("${NO_EQUIVALENT}") or leave it — never invent a comparison or a modern conversion.`;
  return contexts
    .map((c) => `- money context ${c.id}: ${c.amountText} ${unitFor(c.currency, c.amount)}${c.item ? ` (${c.item})` : ''} — ${c.explanation}. Rests on ${c.sourceClaimKeys.join(' and ')} (${c.verdict}: ${c.presentation.toLowerCase().replace(/_/g, ' ')}); confidence ${c.confidence.toLowerCase()}${c.approximate ? '; approximate — say "about"' : ''}. Method: ${c.methodology}`)
    .join('\n');
}
