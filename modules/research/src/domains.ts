import type { SourceType } from '@docengine/core';
import { matchesDomain } from './urls.ts';

/**
 * Domain knowledge used to steer search and to *hint* at a source's type.
 * The final SourceType is decided by the model after reading the page (a
 * university domain can host a student blog; a book page can be a review).
 */

export const SCHOLARLY_DOMAINS = [
  'jstor.org', 'cambridge.org', 'academic.oup.com', 'oup.com', 'tandfonline.com', 'sciencedirect.com',
  'link.springer.com', 'springer.com', 'onlinelibrary.wiley.com', 'journals.uchicago.edu', 'muse.jhu.edu',
  'nber.org', 'ssrn.com', 'aeaweb.org', 'econstor.eu', 'ideas.repec.org', 'journals.openedition.org', 'persee.fr',
  'bmgn-lchr.nl', 'tseg.nl', 'scholar.archive.org', 'eh.net', 'cepr.org', 'voxeu.org',
] as const;

export const BOOK_DOMAINS = [
  'books.google.com', 'press.uchicago.edu', 'press.princeton.edu', 'yalebooks.yale.edu', 'hup.harvard.edu',
  'global.oup.com', 'gutenberg.org', 'penguin.co.uk', 'penguinrandomhouse.com',
] as const;

export const ARCHIVE_DOMAINS = [
  'archive.org', 'hathitrust.org', 'dbnl.org', 'delpher.nl', 'kb.nl', 'rijksmuseum.nl', 'metmuseum.org',
  'britishmuseum.org', 'franshalsmuseum.nl', 'noord-hollandsarchief.nl', 'stadsarchief.amsterdam.nl',
  'archieven.nl', 'nationaalarchief.nl', 'loc.gov', 'bl.uk', 'europeana.eu', 'wellcomecollection.org',
  'getty.edu', 'si.edu', 'nga.gov', 'fitzmuseum.cam.ac.uk', 'rkd.nl', 'huygens.knaw.nl', 'resources.huygens.knaw.nl',
] as const;

export const REPUTABLE_SECONDARY_DOMAINS = [
  'economist.com', 'ft.com', 'nytimes.com', 'theguardian.com', 'bbc.com', 'bbc.co.uk', 'smithsonianmag.com',
  'historytoday.com', 'daily.jstor.org', 'publicdomainreview.org', 'newyorker.com', 'theatlantic.com', 'npr.org',
  'washingtonpost.com', 'wsj.com', 'bloomberg.com', 'atlasobscura.com', 'lrb.co.uk', 'nybooks.com', 'aeon.co',
] as const;

export const REFERENCE_DOMAINS = [
  'wikipedia.org', 'britannica.com', 'worldhistory.org', 'encyclopedia.com', 'investopedia.com', 'oxfordreference.com',
] as const;

/**
 * Never useful as historical evidence: social media, and document-sharing
 * sites (user uploads of unknown provenance, usually truncated previews).
 */
export const EXCLUDED_DOMAINS = [
  'instagram.com', 'facebook.com', 'tiktok.com', 'pinterest.com', 'x.com', 'twitter.com', 'reddit.com', 'quora.com',
  'youtube.com', 'linkedin.com', 'threads.net', 'snapchat.com',
  'scribd.com', 'studocu.com', 'coursehero.com', 'pdfcoffee.com', 'dokumen.pub',
] as const;

/** Domains search should favour (Tavily "prefer" mode: others still appear). */
export const PREFERRED_DOMAINS: readonly string[] = [...SCHOLARLY_DOMAINS, ...BOOK_DOMAINS, ...ARCHIVE_DOMAINS, ...REPUTABLE_SECONDARY_DOMAINS];

const ACADEMIC_TLDS = /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/;

export function sourceTypeHint(domain: string): SourceType {
  if (matchesDomain(domain, SCHOLARLY_DOMAINS)) return 'ACADEMIC';
  if (matchesDomain(domain, ARCHIVE_DOMAINS)) return 'ARCHIVE';
  if (matchesDomain(domain, BOOK_DOMAINS)) return 'BOOK';
  if (matchesDomain(domain, REPUTABLE_SECONDARY_DOMAINS)) return 'REPUTABLE_SECONDARY';
  if (matchesDomain(domain, REFERENCE_DOMAINS)) return 'GENERAL_REFERENCE';
  if (ACADEMIC_TLDS.test(domain)) return 'ARCHIVE'; // universities: refined by the model after reading
  return 'GENERAL_WEB';
}

export function isExcludedDomain(domain: string): boolean {
  return matchesDomain(domain, EXCLUDED_DOMAINS);
}
