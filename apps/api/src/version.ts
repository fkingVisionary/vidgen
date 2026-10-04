declare const __APP_VERSION__: string | undefined;

/** Injected by the production build (build.mjs); "dev" when running from source. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
