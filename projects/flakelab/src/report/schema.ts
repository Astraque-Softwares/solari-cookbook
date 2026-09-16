import { z } from "zod"

import { faultSetSchema } from "../domain/schema.js"

export const failureOwnershipSchema = z.enum([
  "PRODUCT_RACE",
  "TEST_SELECTOR",
  "TEST_STATE_LEAK",
  "BACKEND_NONDETERMINISM",
  "AUTH_EXPIRATION",
  "EXTERNAL_DEPENDENCY",
  "INFRASTRUCTURE_PRESSURE",
  "UNKNOWN",
])

const resultSchema = z.object({
  errors: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failureRate: z.number().min(0).max(1),
  lowerBound80: z.number().min(0).max(1),
  passed: z.number().int().nonnegative(),
  trials: z.number().int().nonnegative(),
})

const representativeRunSchema = z.object({
  artifacts: z.array(z.object({
    contentType: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1).max(500),
  })).max(5),
  durationMs: z.number().int().nonnegative(),
  status: z.enum(["failed", "passed"]),
  trialId: z.string().min(1),
})

export const evidenceReportSchema = z.object({
  generatedAt: z.iso.datetime(),
  repository: z.object({
    drift: z.literal("unchanged"),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  }).optional(),
  status: z.enum(["FIX_PROVEN", "PATCH_REJECTED"]),
  test: z.string().min(1).max(500),
  model: z.string().min(1).max(200),
  conclusion: z.string().min(1).max(2_000),
  causalClaim: z.object({
    controlExperimentIds: z.array(z.string().min(1)).min(1),
    interventionExperimentIds: z.array(z.string().min(1)).min(1),
  }),
  ownership: z.object({
    classification: failureOwnershipSchema,
    confidence: z.enum(["high", "medium", "low"]),
    rationale: z.string().min(1).max(1_000),
  }),
  trigger: z.object({
    faults: faultSetSchema,
    minimumFailureRate: z.number().gt(0).max(1),
    signature: z.string().min(1).max(200).optional(),
  }),
  hypotheses: z.array(z.object({
    id: z.string().min(1),
    statement: z.string().min(1).max(500),
    status: z.enum(["proposed", "rejected", "confirmed"]),
    explanation: z.string().max(1_000),
    evidenceExperimentIds: z.array(z.string().min(1)),
  })),
  experiments: z.array(z.object({
    id: z.string().min(1),
    hypothesisId: z.string().min(1),
    condition: z.string().min(1).max(500),
    representativeRuns: z.array(representativeRunSchema).max(2),
    result: resultSchema,
  })),
  replayCommand: z.string().min(1).max(1_000),
  sourcePaths: z.array(z.string().min(1).max(500)).min(1).max(8),
  sourceLocations: z.array(z.object({
    line: z.number().int().positive(),
    path: z.string().min(1).max(500),
  })).min(1).max(3),
  proof: z.object({
    accepted: z.boolean(),
    execution: z.literal("solari-microvm"),
    outcome: z.enum(["candidate-rejected", "candidate-proven"]).optional(),
    resources: z.object({
      created: z.number().int().nonnegative(),
      live: z.number().int().nonnegative(),
      released: z.number().int().nonnegative(),
    }).optional(),
    staticChecks: z.object({ typecheck: z.boolean().nullable(), lint: z.boolean().nullable() }),
    matrix: z.array(z.object({
      label: z.string().min(1),
      result: resultSchema,
    })).min(3),
  }),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
  }),
  artifacts: z.array(z.object({
    label: z.string().min(1).max(100),
    path: z.string().min(1).max(500),
  })).min(3),
}).strict()

export type EvidenceReport = z.infer<typeof evidenceReportSchema>
export type FailureOwnership = z.infer<typeof failureOwnershipSchema>
