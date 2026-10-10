/**
 * Storyboard Engine V1: what the viewer sees, when, why, and how it should
 * be produced — planned on the real narration clock, with nothing generated.
 * The pure core: the narration spine and cut points, timing, inheritance and
 * the class rules, routing and cost forecasts, approaches and alternatives,
 * continuity, QA and rhythm, edits, hashes and staleness, and the model I/O
 * contract. Around it: the planning stage (VISUAL_PLAN and the
 * STORYBOARD_PREVIEW side job), versions in the database, the editor's
 * service (requests, edits, re-timing, restores, decisions), the STORYBOARD
 * gate, the visual profile library and the read models.
 */
export { buildSpine, SpineIntegrityError, PAUSE_CUT_MS, SILENCE_MIN_MS, type CutPoint, type Spine, type SpineBlock, type SpineSection, type SpineWord } from './spine.ts';
export { displayId, minDurationMs, rangeOf, silenceInside, spanRows, timeStoryboard, LEAD_MAX_MS, type BeatGeometry, type ShotGeometry, type TimingResult } from './timing.ts';
export {
  draftOf,
  droppedNote,
  droppedReferences,
  emptyContent,
  keyNumber,
  nextKey,
  type BeatProposal,
  type DraftBeat,
  type DraftShot,
  type DraftSubject,
  type PlannedBeat,
  type PlannedShot,
  type PlannedStoryboard,
  type PlannedSubject,
  type ShotContent,
  type SpanRow,
  type StoryboardDraft,
  type StoryboardFacts,
} from './draft.ts';
export {
  ASSERTIVENESS,
  beatBases,
  blockFacts,
  claimAllowed,
  claimFacts,
  contextClaims,
  coveredClaims,
  deriveClass,
  evidenceSnapshot,
  groundedSpec,
  inheritedMustAvoid,
  inheritedMustShow,
  isFictional,
  isReal,
  labelObligation,
  narrationCap,
  narrativeClass,
  presentationOf,
  shotDepiction,
  type BlockFacts,
  type ClaimFact,
  type ClassInput,
  type InheritedMustShow,
} from './inherit.ts';
export { continuityRequirement, planSubjects, resolveDetail, resolveSubject, shotSubjectKeys, sortSubjects, subjectBasis, subjectClass, type SubjectProposal } from './continuity.ts';
export { allowedMethods, candidatesFor, costRollup, priceCandidate, pricingSnapshot, rerollsFor, rollupBasis, rollupTotal, routeShot, type CostedShot, type RouteRequest, type RouteResult } from './route.ts';
export { approachSummaries, beatPeople, beatsToReplan, checkOptions, chooseApproach, optionAllowed, replacedOptions, switchApproach } from './approaches.ts';
export { costAlternatives } from './alternatives.ts';
export { checkStoryboard, deviceRealized, shotContext, DATA_TREATMENTS, type CheckOptions, type ShotContext } from './rules.ts';
export { isMoving, rhythmFindings, rhythmStats } from './rhythm.ts';
export { avoidedMatches, periodDetails, shownWords, visibleText } from './anachronism.ts';
export { evidenceCoverage, planStoryboard, RECONSTRUCTION_LABEL } from './plan.ts';
export { beatHash, canonical, sha256, shotHash, subjectHash } from './hash.ts';
export { applyEdits, carriedDecisions, sameDuration, versionChanges, EditError, type DecidedShot, type EditOptions } from './edits.ts';
export { narrationApprovalOf, staleFindings, type LiveFacts, type PinnedFacts } from './stale.ts';
export {
  applyBeatRevisions,
  applyRepair,
  beatsToRepair,
  markUnplanned,
  repairFindings,
  repairOutcome,
  repairPartition,
  repairReasons,
  resolveBeats,
  resolveShots,
  sortShots,
  unplannedShot,
  REPAIR_FIX_LIMIT,
  REPAIRABLE,
  type ResolvedShots,
} from './normalize.ts';
export { BeatOutput, BeatRevision, BeatsOutput, RepairOutput, ShotOutput, ShotsOutput, SubjectOutput } from './schemas.ts';
export { createStoryboardStage } from './stage.ts';
export { BEATS_BATCH_BLOCKS, DEFAULT_STORYBOARD_CONFIG, STORYBOARD_STEP_KINDS, parseStoryboardModels, stepKind, storyboardSteps, type StoryboardConfig, type StoryboardStepKind } from './config.ts';
export { PROMPT_VERSION, beatsSystemPrompt, repairSystemPrompt, shotsSystemPrompt } from './prompts.ts';
export { beatsPrompt, blockBrief, clock, eraBrief, markedText, repairPrompt, sectionBrief, shotsPrompt } from './render.ts';
export { InputError, gateAssemblyId, liveFacts, liveFactsMany, narrationInputs, pinnedFacts, readNarration, resolveInputs, versionFacts, type ResolveArgs, type ResolvedInputs } from './inputs.ts';
export { STORYBOARD_INCLUDE, contentOf, latestShotDecisions, loadStoryboard, lockProject, saveVersion, toLoaded, usedShotKeys, type LoadedStoryboard, type SaveVersionArgs, type SavedVersion, type StoryboardPins, type StoryboardRow } from './store.ts';
export { summaryLine } from './log.ts';
export { StoryboardService, type StoryboardServiceDeps } from './service.ts';
export { editStoryboard, restoreStoryboard, retimeStoryboard, type EditingDeps, type MadeVersion } from './editing.ts';
export { VersionConflictError, approvalBlockers, carryDecisions, decideShot, decideVersion, newestVersion, requireNewest, supersedeApproved, type DecisionDeps } from './decisions.ts';
export { storyboardGate } from './gate.ts';
export {
  VisualProfileError,
  applyOverrides,
  configDifferences,
  createVisualProfileFamily,
  duplicateVisualProfile,
  ensurePresets,
  familyCurrent,
  newVisualProfileVersion,
  originOf,
  productionSnapshot,
  profileConfig,
  resolveVisualProduction,
  setVisualSelection,
  unknownPreferences,
  updateVisualProfileFamily,
  type SavedVisualSelection,
  type VisualProduction,
  type VisualProfileRow,
} from './profiles.ts';
export {
  PHASE_STATUSES,
  PREVIEW_STATUSES,
  liveQa,
  loadStoryboardInputs,
  loadStoryboardView,
  loadVisualLibrary,
  loadVisualProduction,
  loadVisualProfileHistory,
  phaseAllowed,
  productionView,
  profileViews,
  storyboardSummaries,
  storyboardSummary,
  type LiveQa,
  type StoryboardViewDeps,
  type VisualProfileViewDeps,
} from './views.ts';
