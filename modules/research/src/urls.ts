/** URL handling for source de-duplication and validation. */

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|igshid|_hsenc|_hsmi|spm)$/i;
const RESERVED_TLDS = new Set(['invalid', 'test', 'localhost', 'example', 'local', 'internal']);

/**
 * Canonical identity of a web source: lower-case host without "www.",
 * http/https treated alike, no fragment, no tracking parameters, sorted
 * query, no trailing slash. Returns null for anything that is not a valid
 * public http(s) URL.
 */
export function normalizeUrl(raw: string): string | null {
  if (!isValidSourceUrl(raw)) return null;
  const url = new URL(raw.trim());
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const path = url.pathname.replace(/\/+$/, '') || '';
  return `${host}${url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : ''}${path}${query}`;
}

export function domainOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** A public http(s) URL with a real-looking host (no IPs, no reserved TLDs, no credentials). */
export function isValidSourceUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.')) return false;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return false; // IPv4 / IPv6 literals
  const tld = host.split('.').pop() ?? '';
  return tld.length >= 2 && !RESERVED_TLDS.has(tld);
}

/** True when `domain` equals or is a subdomain of any entry. */
export function matchesDomain(domain: string, list: readonly string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}
