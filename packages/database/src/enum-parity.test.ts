import * as core from '@docengine/core';
import { describe, expect, it } from 'vitest';
import * as prismaEnums from './generated/prisma/enums.ts';

/**
 * The database enums (schema.prisma) and the domain enums (packages/core) are
 * declared separately — the dashboard must not import Prisma. This test makes
 * any drift between them a build failure.
 */
const PAIRS: Record<string, readonly string[]> = {
  ProjectStatus: core.PROJECT_STATUSES,
  JobType: core.JOB_TYPES,
  JobStatus: core.JOB_STATUSES,
  ApprovalGate: core.APPROVAL_GATES,
  ApprovalDecision: core.APPROVAL_DECISIONS,
  ArtifactStatus: core.ARTIFACT_STATUSES,
  SourceType: core.SOURCE_TYPES,
  ClaimVerdict: core.CLAIM_VERDICTS,
  ConfidenceLevel: core.CONFIDENCE_LEVELS,
  ClaimType: core.CLAIM_TYPES,
  CitationStance: core.CITATION_STANCES,
  VisualType: core.VISUAL_TYPES,
  ShotType: core.SHOT_TYPES,
  CameraMotion: core.CAMERA_MOTIONS,
  ShotStatus: core.SHOT_STATUSES,
  InfographicType: core.INFOGRAPHIC_TYPES,
  AssetKind: core.ASSET_KINDS,
  RenderStatus: core.RENDER_STATUSES,
  ProviderKind: core.PROVIDER_KINDS,
  ProviderCallStatus: core.PROVIDER_CALL_STATUSES,
  LanguageVersionStatus: core.LANGUAGE_VERSION_STATUSES,
  RetrievalStatus: core.RETRIEVAL_STATUSES,
  ClaimImportance: core.CLAIM_IMPORTANCES,
  CitationBasis: core.CITATION_BASES,
  CostBasis: core.COST_BASES,
};

describe('Prisma enums ↔ core enums', () => {
  it.each(Object.entries(PAIRS))('%s matches exactly (values and order)', (name, coreValues) => {
    const prismaEnum = (prismaEnums as Record<string, Record<string, string>>)[name];
    expect(prismaEnum, `enum ${name} missing from schema.prisma`).toBeDefined();
    expect(Object.values(prismaEnum!)).toEqual([...coreValues]);
  });

  it('has no Prisma enum without a core counterpart', () => {
    const prismaNames = Object.keys(prismaEnums).filter((k) => typeof (prismaEnums as Record<string, unknown>)[k] === 'object');
    expect(prismaNames.sort()).toEqual(Object.keys(PAIRS).sort());
  });
});
