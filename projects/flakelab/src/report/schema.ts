import { z } from "zod"

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

export const evidenceReportSchema = z.object({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  status: z.enum(["FIX_PROVEN", "PATCH_REJECTED"]),
  test: z.string().min(1).max(500),
  model: z.string().min(1).max(200),
  conclusion: z.string().min(1).max(2_000),
  ownership: z.object({
    classification: failureOwnershipSchema,
    confidence: z.enum(["high", "medium", "low"]),
    rationale: z.string().min(1).max(1_000),
  }),
  trigger: z.object({
    kind: z.literal("network-delay"),
    pattern: z.string().min(1).max(500),
    delayMs: z.number().int().positive(),
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
    result: resultSchema,
  })),
  proof: z.object({
    accepted: z.boolean(),
    execution: z.literal("solari-microvm"),
    staticChecks: z.object({ typecheck: z.boolean(), lint: z.boolean() }),
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
})

export type EvidenceReport = z.infer<typeof evidenceReportSchema>
export type FailureOwnership = z.infer<typeof failureOwnershipSchema>
