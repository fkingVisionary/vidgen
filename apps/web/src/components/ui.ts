/**
 * Style constants shared by the storyboard and visual profile pages: the
 * same buttons, pills and fields as the rest of the dashboard, each tall
 * enough to tap.
 */

export const button = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';
export const primary = `${button} bg-stone-900 text-white hover:bg-stone-800`;
export const secondary = `${button} bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-stone-50`;
export const danger = `${button} bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50`;
export const approve = `${button} bg-emerald-700 text-white hover:bg-emerald-600`;
/** A text-styled button that is still at least 24 px tall to tap. */
export const link = 'inline-flex min-h-6 items-center text-xs text-stone-600 underline disabled:cursor-not-allowed disabled:opacity-40';
export const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';
/** A label whose text varies (a name, a provider and model): it wraps on a phone rather than overflow. */
export const tag = 'inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium break-words';
export const input = 'mt-1 w-full min-w-0 rounded-md border border-stone-300 px-2 py-1 text-sm disabled:bg-stone-50';
export const summary = 'inline-flex min-h-6 cursor-pointer items-center text-xs text-stone-600 underline';
