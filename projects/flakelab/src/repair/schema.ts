import { z } from "zod"

import { CANDIDATE_REJECTION_CODES } from "./rejection.js"

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

export const candidateGenerationUsageSchema = z.object({
  estimatedCostUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
})

export const candidateRejectionSchema = z.object({
  attempt: z.number().int().min(1).max(2),
  candidatePath: z.string().min(1).max(500).optional(),
  code: z.enum(CANDIDATE_REJECTION_CODES),
  correctiveAttemptPermitted: z.boolean(),
  diffRendered: z.boolean(),
  message: z.string().min(1).max(2_000),
})

export const candidateAttemptSchema = z.object({
  artifactPaths: z.object({
    candidate: z.string().min(1).max(1_000),
    diff: z.string().min(1).max(1_000).nullable(),
    validation: z.string().min(1).max(1_000),
  }),
  attempt: z.number().int().min(1).max(2),
  candidatePath: z.string().min(1).max(500).nullable(),
  diffRendered: z.boolean(),
  outcome: z.enum(["candidate-invalid", "pending", "valid"]),
  rejection: candidateRejectionSchema.nullable(),
  usage: candidateGenerationUsageSchema,
})

export const candidateGenerationEvidenceSchema = z.object({
  artifactPaths: z.array(z.string().min(1).max(1_000)).max(6),
  attemptCount: z.number().int().min(1).max(2),
  attempts: z.array(candidateAttemptSchema).min(1).max(2),
  correctiveAttemptOccurred: z.boolean(),
  finalRejection: candidateRejectionSchema.nullable(),
  usage: candidateGenerationUsageSchema,
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
  candidateGeneration: candidateGenerationEvidenceSchema.optional(),
  execution: z.literal("solari-microvm"),
  outcome: z.enum([
    "candidate-invalid",
    "candidate-rejected",
    "candidate-proven",
    "proof-infrastructure-failed",
  ]).optional(),
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
  resources: z.object({
    created: z.number().int().nonnegative(),
    live: z.number().int().nonnegative(),
    released: z.number().int().nonnegative(),
  }).optional(),
}).strict()

export const candidateInvalidProofSchema = z.object({
  candidateGeneration: candidateGenerationEvidenceSchema,
  execution: z.literal("local-validation"),
  outcome: z.literal("candidate-invalid"),
  patchAccepted: z.literal(false),
  patchPath: z.string().min(1),
  resources: z.object({
    created: z.literal(0),
    live: z.literal(0),
    released: z.literal(0),
  }),
  sourceLocations: z.array(z.object({
    line: z.number().int().positive(),
    path: z.string().min(1).max(500),
  })).max(3),
  staticChecks: z.object({
    typecheck: z.boolean().nullable(),
    lint: z.boolean().nullable(),
  }),
  staticDiagnostics: z.object({
    typecheck: z.string().max(2_000).optional(),
    lint: z.string().max(2_000).optional(),
  }),
}).strict()

export const repairEvidenceSchema = z.union([proofOfFixSchema, candidateInvalidProofSchema])

export type CandidatePatch = z.infer<typeof candidatePatchSchema>
export type CandidateAttempt = z.infer<typeof candidateAttemptSchema>
export type CandidateGenerationEvidence = z.infer<typeof candidateGenerationEvidenceSchema>
export type CandidateGenerationUsage = z.infer<typeof candidateGenerationUsageSchema>
export type CandidateRejection = z.infer<typeof candidateRejectionSchema>
export type CandidateInvalidProof = z.infer<typeof candidateInvalidProofSchema>
export type ProofOfFix = z.infer<typeof proofOfFixSchema>
export type RepairEvidence = z.infer<typeof repairEvidenceSchema>
