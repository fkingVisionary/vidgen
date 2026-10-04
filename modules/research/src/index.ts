export { createResearchStage } from './stage.ts';
export { DEFAULT_FOCUS_AREAS, DEFAULT_RESEARCH_CONFIG, type QualityThresholds, type ResearchConfig } from './config.ts';
export { PROMPT_VERSION } from './prompts.ts';
export { computeQualityReport } from './quality.ts';
export { buildDraft, normalizeDraft, type DossierDraft, type DraftClaim, type DraftSource, type EvidenceRecord } from './draft.ts';
export { normalizeUrl, isValidSourceUrl, domainOf } from './urls.ts';
export { verifyQuote, normalizeForMatch, textSimilarity } from './text.ts';
export { sourceTypeHint } from './domains.ts';
export { buildDossierReport } from './report.ts';
