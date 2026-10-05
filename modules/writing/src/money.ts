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

/** "1,200" → 1200; "twelve hundred" → 1200; "three thousand" → 3000; "a hundred" → 100; "40 million" → 40000000. */
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
  let seen = false;
  for (const w of t.split(/[\s-]+/)) {
    if (w === 'and') continue;
    if (w in NUMBER_WORDS) {
      current += NUMBER_WORDS[w]!;
      seen = true;
    } else if (w in SCALE) {
      current = (current || 1) * SCALE[w]!;
      if (SCALE[w]! >= 1000) {
        total += current;
        current = 0;
      }
      seen = true;
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

/** Sums of money in a text: "1,200 crowns", "£300", "three hundred pounds". */
export function moneyMentions(text: string, currencies: ReadonlySet<string>): MoneyMention[] {
  const out: MoneyMention[] = [];
  const words = [...currencies].flatMap((c) => [c, `${c}s`, c.endsWith('y') ? `${c.slice(0, -1)}ies` : null].filter(Boolean)).sort((a, b) => b!.length - a!.length);
  const named = new RegExp(String.raw`\b(${NUM})\s+(?:(?:gold|silver|copper|paper)\s+)?(${words.join('|')})\b`, 'gi');
  const symbol = new RegExp(String.raw`([£$€¥])\s?(${DIGITS})`, 'gi');
  for (const s of sentences(maskQuotes(text))) {
    for (const m of s.matchAll(named)) {
      const amount = parseAmount(m[1]!);
      if (amount !== null) out.push({ amount, amountText: m[1]!, currency: singular(m[2]!), sentence: s });
    }
    for (const m of s.matchAll(symbol)) {
      const amount = parseAmount(m[2]!);
      if (amount !== null) out.push({ amount, amountText: m[2]!, currency: SYMBOL[m[1]!]!, sentence: s });
    }
  }
  return out;
}

const WAGE = /\b(?:earn(?:ed|s|ing|t)?|wages?|paid (?:a|per|each|by the)|day'?s (?:work|pay|wage)|salary|stipend)\b/;
const INCOME = /\b(?:income|revenue|rents? of|yielded|annual(?:ly)?|a year'?s? income)\b/;
const HOUSEHOLD = /\b(?:bread|loaf|loaves|rent|beer|ale|meat|food|firewood|household|meal|cheese|butter|candles?|grain|wheat|rye|flour)\b/;
const ASSET = /\b(?:house|houses|home|ship|land|farm|estate|cow|horse|carriage|acres?|building|mansion|workshop|mill)\b/;
const MODERN = /\b(?:today'?s? money|in today'?s|modern (?:money|terms|equivalent)|present-day|equivalent today|in current)\b/;
const PERIOD = /\b(?:a|per|each|every) (day|week|month|year)\b|\b(daily|weekly|monthly|yearly|annual(?:ly)?)\b/;
const TOTAL = /\b(?:total|in all|altogether|all together|the whole|combined|raised)\b/;
const WHO = /\b((?:a|an|the|one) (?:\w+ ){0,2}(?:craftsman|craftsmen|labourer|laborer|worker|carpenter|weaver|sailor|servant|clerk|soldier|artisan|maid|apprentice|mason|teacher|smith|blacksmith|baker|farmhand|shipwright|miner|journeyman|tradesman|official|priest|schoolmaster|seaman|docker|porter|driver|nurse|cook))\b/;

type Period = 'day' | 'week' | 'month' | 'year' | null;
const periodOf = (s: string): Period => {
  const m = PERIOD.exec(s);
  const p = (m?.[1] ?? m?.[2] ?? '').replace(/ly$/, '').replace(/^dai$/, 'day').replace(/^annual$/, 'year');
  return p === 'day' || p === 'week' || p === 'month' || p === 'year' ? p : null;
};

interface MoneyFact extends MoneyMention {
  claimKey: string;
  verdict: ClaimVerdict;
  confidence: ConfidenceLevel;
  kind: MoneyComparisonType | 'PRICE';
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

/** The words around a sum (six on each side): what they say is what the sum is. */
function around(sentence: string, amountText: string): string {
  const words = sentence.split(/\s+/);
  const at = words.findIndex((w) => w.includes(amountText.split(/\s+/)[0]!));
  return at < 0 ? sentence : words.slice(Math.max(0, at - 6), at + 7).join(' ');
}

function classify(sentence: string): MoneyComparisonType | 'PRICE' {
  const s = normalize(sentence);
  if (MODERN.test(s)) return 'MODERN_ESTIMATE';
  if (WAGE.test(s) || (WHO.test(s) && PERIOD.test(s))) return 'CONTEMPORARY_WAGE';
  if (INCOME.test(s)) return 'INCOME';
  if (HOUSEHOLD.test(s)) return 'HOUSEHOLD_EXPENSE';
  if (ASSET.test(s) && !/\bfor\b/.test(s.split(/\d/)[0] ?? '')) return 'ASSET';
  return 'PRICE';
}

/** The currencies of a dossier: the engine's own list and the ones its price evidence names. */
export function currenciesOf(evidence: EvidenceBase): Set<string> {
  return new Set([...BASE_CURRENCIES, ...evidence.content.priceEvidence.map((p) => singular(p.currency.trim().split(/\s+/).at(-1) ?? '')).filter((c) => c.length > 1)]);
}

/** Every sum of money the cited claims state, with what it is (a price, a wage, an income…). */
export function moneyFacts(evidence: EvidenceBase, claimSet: ReadonlySet<string>): MoneyFact[] {
  const currencies = currenciesOf(evidence);
  const out: MoneyFact[] = [];
  const seen = new Set<string>();
  for (const key of claimSet) {
    const c = evidence.claim(key);
    if (!c) continue;
    const texts = [c.statement, ...evidence.verifiedQuotes(key)];
    for (const t of texts) {
      for (const m of moneyMentions(t, currencies)) {
        const id = `${key}|${m.amount}|${m.currency}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const s = normalize(m.sentence);
        const near = around(m.sentence, m.amountText);
        const price = evidence.content.priceEvidence.find((p) => p.claimKeys.includes(key) && parseAmount(p.price) === m.amount);
        const kind = MODERN.test(normalize(near)) ? 'MODERN_ESTIMATE' : price ? classify(`${price.item} ${price.context}`) : classify(near);
        out.push({
          ...m,
          claimKey: key,
          verdict: c.verdict,
          confidence: c.confidence,
          kind,
          period: periodOf(normalize(near)),
          total: TOTAL.test(normalize(near)) || TOTAL.test(normalize(price?.item ?? '')),
          year: yearIn(price?.date) ?? yearIn(m.sentence) ?? yearIn(c.statement),
          item: price?.item ?? null,
          who: WHO.exec(s)?.[1] ?? null,
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

/** A ratio as a narrator would say it: "about four", "nearly five", "more than twenty". */
export function spokenRatio(r: number): { phrase: string; value: number } {
  const rounded = r >= 20 ? Math.round(r / 5) * 5 : Math.round(r);
  const how = Math.abs(r - rounded) < 0.15 ? 'about' : r < rounded ? 'nearly' : 'more than';
  return { phrase: `${how} ${words(rounded)}`, value: rounded };
}

const PLURAL: Record<'day' | 'week' | 'month' | 'year', string> = { day: "days'", week: "weeks'", month: "months'", year: "years'" };
const SINGULAR: Record<'day' | 'week' | 'month' | 'year', string> = { day: "a day's", week: "a week's", month: "a month's", year: "a year's" };

/**
 * The money contexts the evidence supports, for the prices it states. A
 * price is set beside a comparison in the same currency, from the same era
 * (within 25 years when both are dated), never a total beside a wage. A wage
 * or income with a period gives a ratio a narrator can say ("about four
 * years' pay for a skilled craftsman"); any other comparison is given in the
 * evidence's own words. Each context rests on both claims and takes the
 * weaker verdict, which decides how it must be worded.
 */
export function moneyContexts(evidence: EvidenceBase, claimSet: ReadonlySet<string>): HistoricalMoneyContext[] {
  const facts = moneyFacts(evidence, claimSet);
  const prices = facts.filter((f) => f.kind === 'PRICE');
  const comparisons = facts.filter((f) => f.kind !== 'PRICE');
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
      const periodic = (kind === 'CONTEMPORARY_WAGE' || kind === 'INCOME') && r.period && r.amount > 0;
      let ratio: number | null = null;
      let explanation: string;
      let methodology: string;
      const who = r.who ? ` for ${r.who}` : '';
      if (periodic) {
        ratio = Math.round((p.amount / r.amount) * 100) / 100;
        const period = r.period!;
        if (ratio >= 1.5) {
          const s = spokenRatio(ratio);
          explanation = `${s.phrase} ${PLURAL[period]} pay${who}`;
        } else if (ratio >= 0.75) explanation = `about ${SINGULAR[period]} pay${who}`;
        else explanation = `a fraction of ${SINGULAR[period]} pay${who}`;
        methodology = `${p.claimKey} gives ${p.amountText} ${unitFor(p.currency, p.amount)}${p.item ? ` (${p.item})` : ''}; ${r.claimKey} gives ${r.amountText} ${unitFor(r.currency, r.amount)} a ${period}${who}: ${p.amount} ÷ ${r.amount} = ${ratio}, said as "${explanation}".`;
      } else if (kind === 'MODERN_ESTIMATE') {
        explanation = r.sentence;
        methodology = `${r.claimKey} itself gives a modern estimate for ${p.amountText} ${unitFor(p.currency, p.amount)}: approximate, and only as the evidence words it.`;
      } else {
        explanation = `for comparison, the evidence gives: "${r.sentence}"`;
        methodology = `${p.claimKey} gives ${p.amountText} ${unitFor(p.currency, p.amount)}; ${r.claimKey} gives ${r.amountText} ${unitFor(r.currency, r.amount)} for ${kind === 'ASSET' ? 'an asset' : 'a household expense'} — set side by side, no arithmetic beyond what the evidence says.`;
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

/** Words that already give a sum some meaning. */
const CONTEXT_WORDS = /\b(?:earn(?:ed|s|t)?|wages?|pay|paid|salary|income|a year'?s|years'|months'|weeks'|days'|as much as|more than|worth|enough to buy|the price of|cost of|equal to|for comparison|records don'?t give)\b/;

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
      const contextualised = near.some((x) => CONTEXT_WORDS.test(normalize(maskQuotes(x.text))));
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
