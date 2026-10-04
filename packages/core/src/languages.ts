/**
 * Languages the system is designed to localize into. English is only the
 * default *master* language — nothing in the architecture assumes it.
 */
export const SUPPORTED_LANGUAGES = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
} as const;

export type LanguageCode = keyof typeof SUPPORTED_LANGUAGES;

export const LANGUAGE_CODES = Object.keys(SUPPORTED_LANGUAGES) as [LanguageCode, ...LanguageCode[]];

export const DEFAULT_MASTER_LANGUAGE: LanguageCode = 'en';

export function isLanguageCode(value: string): value is LanguageCode {
  return Object.hasOwn(SUPPORTED_LANGUAGES, value);
}
