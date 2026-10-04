import type { SourceType } from '@docengine/core';
import { PROMPT_VERSION } from './prompts.ts';

/**
 * Saved progress of a research job (jobs.checkpoint). Each paid step —
 * plan, searches, triage, retrieval, synthesis, review — stores its result,
 * and a retry (automatic, or a manual Retry, which inherits the checkpoint)
 * resumes after the last completed step instead of paying for it again.
 * Reading needs no entry: readings are cached per stored document.
 *
 * A checkpoint written by a different format or prompt version is ignored
 * and the run starts over, because its outputs would not match the code.
 */
export const CHECKPOINT_VERSION = 1;

export interface PlanQuestion {
  id: string;
  category: string;
  question: string;
  rationale: string;
  queries: string[];
}

export interface SavedCandidate {
  id: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  title: string;
  snippet: string;
  score: number;
  publishedDate: string | null;
  hint: SourceType;
  questionIds: string[];
  queries: string[];
}

export interface SavedRetrieved {
  sourceId: string;
  key: string;
  url: string;
  domain: string;
  title: string;
  hint: SourceType;
  documentId: string;
  duplicateOfId: string | null;
  sourceType: SourceType;
  note: string | null;
}

export interface ResearchCheckpoint {
  version: number;
  promptVersion: string;
  /** Run statistics as of each saved step up to retrieval, restored with the step; later steps recount (reading from cache). */
  stats?: Partial<Record<string, Record<string, unknown>>>;
  plan?: PlanQuestion[];
  candidates?: SavedCandidate[];
  selection?: { id: string; hint: SourceType }[];
  retrieved?: SavedRetrieved[];
  /** Raw model outputs; re-validated with their schemas before reuse. */
  synthesis?: unknown;
  review?: unknown;
}

export function emptyCheckpoint(): ResearchCheckpoint {
  return { version: CHECKPOINT_VERSION, promptVersion: PROMPT_VERSION };
}

/** The stored checkpoint if it was written by this format and prompt version, else a fresh one. */
export function readCheckpoint(raw: unknown): { checkpoint: ResearchCheckpoint; ignored: boolean } {
  if (!raw || typeof raw !== 'object') return { checkpoint: emptyCheckpoint(), ignored: false };
  const cp = raw as Partial<ResearchCheckpoint>;
  if (cp.version !== CHECKPOINT_VERSION || cp.promptVersion !== PROMPT_VERSION) return { checkpoint: emptyCheckpoint(), ignored: true };
  return { checkpoint: cp as ResearchCheckpoint, ignored: false };
}
