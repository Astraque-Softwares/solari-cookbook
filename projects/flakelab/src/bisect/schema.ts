import { z } from "zod"

export const revisionSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40}$/u),
  shortHash: z.string().regex(/^[0-9a-f]{7,12}$/u),
  subject: z.string().min(1).max(500),
})

export const revisionEvidenceSchema = z.object({
  revision: revisionSchema,
  classification: z.enum(["good", "bad", "incompatible", "inconclusive"]),
  reason: z.string().min(1).max(500),
  trials: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  failureRate: z.number().min(0).max(1),
  lowerBound80: z.number().min(0).max(1),
  upperBound80: z.number().min(0).max(1),
  snapshotReuseCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
})

export const bisectReportSchema = z.object({
  version: z.literal(1),
  goodRevision: revisionSchema,
  badRevision: revisionSchema,
  firstFailingCommit: revisionSchema.nullable(),
  earliestKnownBadCommit: revisionSchema,
  exact: z.boolean(),
  minimumFailureRate: z.number().gt(0).max(1),
  evaluatedRevisionCount: z.number().int().min(2),
  totalRevisionCount: z.number().int().min(2),
  evidence: z.array(revisionEvidenceSchema).min(2),
})

export type BisectReport = z.infer<typeof bisectReportSchema>
export type Revision = z.infer<typeof revisionSchema>
export type RevisionEvidence = z.infer<typeof revisionEvidenceSchema>
