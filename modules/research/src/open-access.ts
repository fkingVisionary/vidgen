/**
 * Finding an open-access copy of a scholarly work whose publisher page could
 * not be retrieved (JSTOR, journal sites): which search to run, and whether a
 * search result is the same work. Deliberately conservative: a wrong "copy"
 * would put another document's words under a scholar's name.
 */

const SITE_SUFFIX =
  /\s*(?:[|–—-]\s*|\bon\s+)(?:jstor|ssrn|wiley online library|taylor & francis online|tandfonline|sciencedirect|cambridge core|oxford academic|project muse|econstor|researchgate|academia\.edu|google books|springer nature link|springerlink|springer|sage journals|semantic scholar)\s*$/i;

/** A search-result title without the hosting site's name ("… | JSTOR", "… on JSTOR") or a "[PDF]" marker. */
export function cleanTitle(title: string): string {
  let t = title.replace(/^\s*[[(]pdf[\])]\s*/i, '').trim();
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(SITE_SUFFIX, '').trim();
  }
  return t;
}

/**
 * A publisher page title split into the work's own title and its context:
 * "Tulipmania | Journal of Political Economy: Vol 97, No 3" → main
 * "Tulipmania", context "Journal of Political Economy: Vol 97, No 3";
 * "Rational bubbles and middlemen - Awaya - 2022" → context "Awaya 2022".
 */
export function splitTitle(title: string): { main: string; context: string } {
  const parts = cleanTitle(title).split(/\s+\|\s+/);
  let main = parts[0]!.trim();
  const context = parts.slice(1);
  const authorYear = /^(.*?)\s+[-–]\s+([^-–]{2,60}?)\s+[-–]\s+((?:1[5-9]|20)\d{2})$/.exec(main);
  if (authorYear) {
    main = authorYear[1]!.trim();
    context.unshift(`${authorYear[2]} ${authorYear[3]}`);
  }
  return { main, context: context.join(' ').trim() };
}

const TITLE_STOPWORDS = new Set(['the', 'and', 'for', 'from', 'with', 'into', 'its', 'their', 'pdf']);

/** Distinct words of three or more letters/digits, accents removed. */
export function titleTokens(title: string): string[] {
  const words = cleanTitle(title).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !TITLE_STOPWORDS.has(w)))];
}

/** Share of the reference text's words found in the candidate text (0–1). */
export function titleMatch(reference: string, candidate: string): number {
  const a = titleTokens(reference);
  if (a.length === 0) return 0;
  const b = new Set(titleTokens(candidate));
  return a.filter((w) => b.has(w)).length / a.length;
}

export interface OpenAccessLookup {
  main: string;
  context: string;
  query: string;
}

/**
 * The search for an open-access copy, or null when the title is too
 * ambiguous to look up safely (a one-word title with no journal or author).
 */
export function openAccessLookup(title: string): OpenAccessLookup | null {
  const { main, context } = splitTitle(title);
  if (/\bvol\.?\s*\d+\s*,?\s*(?:no|issue)\.?\s*\d+/i.test(main)) return null; // a journal issue's table of contents, not a work
  const n = titleTokens(main).length;
  if (n >= 3) return { main, context, query: `"${main}" pdf` };
  if (n >= 1 && titleTokens(context).length >= 2) return { main, context, query: `"${main}" ${context} pdf` };
  return null;
}

export const SAME_WORK_THRESHOLD = 0.8;

/**
 * How likely a search result is the same work (0–1; accepted at 0.8). A
 * distinctive title (three or more words) must reappear in the result's
 * title: all of a three-word title, four of five words (search titles are
 * often cut off with "…"). A short title must open the result's title, and
 * the journal or author context must appear in its title or snippet.
 */
export function sameWorkScore(lookup: OpenAccessLookup, title: string, snippet: string): number {
  const main = titleTokens(lookup.main);
  if (main.length >= 3) return titleMatch(lookup.main, title);
  const opening = titleTokens(title).slice(0, main.length);
  if (main.some((w, i) => opening[i] !== w)) return 0;
  return titleMatch(lookup.context, `${title} ${snippet}`);
}
