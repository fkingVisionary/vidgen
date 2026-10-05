/**
 * The story engine's evidence, rule and job helpers, shared with the script
 * engine (which tells an approved architecture and must keep its evidence
 * boundary). Read-only use of the research record, as in the story stages.
 */
export { EvidenceBase, type EvidenceClaim } from './evidence.ts';
export { StepCheckpoint } from './checkpoint.ts';
export { CostCeiling, CostCeilingError } from './util.ts';
export { SECOND_PERSON, checkFigures, checkPerson, orderedKeys, strongestFirst } from './rules.ts';
export { outsidePeople, peopleMentioned } from './architecture.ts';
export {
  INTERACTION_VERBS,
  MENTAL_VERBS,
  extractFigures,
  isYear,
  mentionsName,
  nameTokens,
  normalize,
  quoteFoundIn,
  quotedPassages,
  sentences,
  subjectVerbObject,
  unknownProperNouns,
  wordTokens,
} from './text.ts';
