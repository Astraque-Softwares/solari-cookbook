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
  causalEffect: z.object({
    controlFailures: z.number().int().nonnegative(),
    controlRate: z.number().min(0).max(1),
    controlUpperBound80: z.number().min(0).max(1),
    failureRateIncrease: z.number().min(-1).max(1),
    signature: z.string().min(1),
    treatmentFailures: z.number().int().nonnegative(),
    treatmentLowerBound80: z.number().min(0).max(1),
    treatmentRate: z.number().min(0).max(1),
  }).optional(),
  confirmed: z.boolean(),
  dominantFailureSignature: z.string().min(1).optional(),
  dominantFailureReason: z.string().min(1).max(2_000).optional(),
  errors: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failureRate: z.number().min(0).max(1),
  failureSignatures: z.array(z.object({
    failures: z.number().int().positive(),
    failureRate: z.number().min(0).max(1),
    lowerBound80: z.number().min(0).max(1),
    signature: z.string().min(1),
    upperBound80: z.number().min(0).max(1),
  })),
  lowerBound80: z.number().min(0).max(1),
  passed: z.number().int().nonnegative(),
  trials: z.number().int().nonnegative(),
  upperBound80: z.number().min(0).max(1),
})

export const proofOfFixSchema = z.object({
  execution: z.literal("solari-microvm"),
  patchAccepted: z.boolean(),
  patchPath: z.string().min(1),
  sourceLocations: z.array(z.object({
    line: z.number().int().positive(),
    path: z.string().min(1).max(500),
  })).min(1).max(3),
  staticChecks: z.object({
    typecheck: z.boolean().nullable(),
    lint: z.boolean().nullable(),
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
}).strict()

export type CandidatePatch = z.infer<typeof candidatePatchSchema>
export type ProofOfFix = z.infer<typeof proofOfFixSchema>
