import { z } from "zod"

export const patchEditSchema = z.object({
  path: z.string().min(1).max(500),
  before: z.string().min(1).max(12_000),
  after: z.string().min(1).max(12_000),
})

export const candidatePatchSchema = z.object({
  summary: z.string().min(20).max(1_000),
  rationale: z.string().min(20).max(2_000),
  edits: z.array(patchEditSchema).min(1).max(3),
})

const validationResultSchema = z.object({
  confirmed: z.boolean(),
  dominantFailureSignature: z.string().min(1).optional(),
  dominantFailureReason: z.string().min(1).max(2_000).optional(),
  errors: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failureRate: z.number().min(0).max(1),
  lowerBound80: z.number().min(0).max(1),
  passed: z.number().int().nonnegative(),
  trials: z.number().int().nonnegative(),
})

export const proofOfFixSchema = z.object({
  version: z.literal(1),
  execution: z.literal("solari-microvm"),
  patchAccepted: z.boolean(),
  patchPath: z.string().min(1),
  staticChecks: z.object({
    typecheck: z.boolean(),
    lint: z.boolean(),
  }),
  staticDiagnostics: z.object({
    typecheck: z.string().max(2_000).optional(),
    lint: z.string().max(2_000).optional(),
  }),
  beforeHostile: validationResultSchema,
  afterHostile: validationResultSchema,
  afterControl: validationResultSchema,
  regressions: z.array(z.object({
    selector: z.string().min(1),
    result: validationResultSchema,
  })),
})

export type CandidatePatch = z.infer<typeof candidatePatchSchema>
export type ProofOfFix = z.infer<typeof proofOfFixSchema>
