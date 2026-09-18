import { z } from "zod"

import {
  browserStorageAreaSchema,
  browserStorageKeySchema,
  cookieNameSchema,
  loadingResourceTypeSchema,
  localeSchema,
  startupEventSchema,
  timeZoneSchema,
} from "../domain/schema.js"

export const experimentResultSchema = z.object({
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
  dominantErrorReason: z.string().min(1).max(2_000).optional(),
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
  representativeRuns: z.array(z.object({
    artifacts: z.array(z.object({
      contentType: z.string().min(1),
      name: z.string().min(1),
      path: z.string().min(1),
    })).max(5),
    durationMs: z.number().int().nonnegative(),
    status: z.enum(["failed", "passed"]),
    trialId: z.string().min(1),
  })).max(2),
  trials: z.number().int().nonnegative(),
  upperBound80: z.number().min(0).max(1),
})

export const experimentConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("baseline") }),
  z.object({
    kind: z.literal("animation-speed"),
    rate: z.number().min(0.1).max(10),
  }),
  z.object({
    kind: z.literal("auth-cookie-expiry"),
    cookieName: cookieNameSchema,
  }),
  z.object({
    kind: z.literal("clock-jump"),
    jumpAfterMs: z.number().int().min(0).max(30_000),
    offsetMs: z.number().int().min(-31_536_000_000).max(31_536_000_000)
      .refine((value) => value !== 0, "offsetMs cannot be zero"),
  }),
  z.object({
    kind: z.literal("event-loop-stall"),
    durationMs: z.number().int().min(1).max(2_000),
    startAfterMs: z.number().int().min(0).max(30_000),
  }),
  z.object({
    kind: z.literal("network-delay"),
    delayMs: z.number().int().min(1).max(30_000),
  }),
  z.object({
    kind: z.literal("locale"),
    locale: localeSchema,
  }),
  z.object({
    kind: z.literal("request-failure"),
    statusCode: z.number().int().min(400).max(599),
  }),
  z.object({ kind: z.literal("reduced-motion") }),
  z.object({
    kind: z.literal("response-truncation"),
    removeBytes: z.number().int().min(1).max(1_024),
  }),
  z.object({
    kind: z.literal("response-duplication"),
    duplicateBytes: z.number().int().min(1).max(1_024),
  }),
  z.object({
    kind: z.literal("response-reordering"),
    holdMs: z.number().int().min(1).max(30_000),
  }),
  z.object({
    kind: z.literal("resource-loading-delay"),
    delayMs: z.number().int().min(1).max(30_000),
    resourceType: loadingResourceTypeSchema,
  }),
  z.object({
    kind: z.literal("startup-event-delay"),
    delayMs: z.number().int().min(1).max(30_000),
    event: startupEventSchema,
  }),
  z.object({
    kind: z.literal("storage-state-delay"),
    delayMs: z.number().int().min(1).max(30_000),
    key: browserStorageKeySchema,
    storage: browserStorageAreaSchema,
  }),
  z.object({
    kind: z.literal("timezone"),
    timezoneId: timeZoneSchema,
  }),
  z.object({
    kind: z.literal("viewport"),
    height: z.number().int().min(200).max(7_680),
    width: z.number().int().min(200).max(7_680),
  }),
  z.object({
    kind: z.literal("worker-pressure"),
    workers: z.number().int().min(2).max(16),
  }),
  z.object({
    copies: z.number().int().min(2).max(16),
    kind: z.literal("shared-state-interference"),
  }),
])

export const hypothesisSchema = z.object({
  id: z.string().regex(/^H\d+$/u),
  statement: z.string().min(8).max(500),
  prediction: z.string().min(8).max(500),
  status: z.enum(["proposed", "rejected", "confirmed", "corroborating"]),
  evidenceExperimentIds: z.array(z.string().regex(/^E\d+$/u)),
  explanation: z.string().max(1_000),
})

export const experimentEvidenceSchema = z.object({
  id: z.string().regex(/^E\d+$/u),
  hypothesisId: z.string().regex(/^H\d+$/u),
  condition: experimentConditionSchema,
  result: experimentResultSchema,
})

export const investigationReportSchema = z.object({
  test: z.string().min(1),
  model: z.string().min(1),
  sourcePaths: z.array(z.string().min(1).max(500)).min(1).max(8),
  conclusion: z.string().min(8).max(2_000),
  conclusionHypothesisId: z.string().regex(/^H\d+$/u),
  conclusionEvidenceIds: z.array(z.string().regex(/^E\d+$/u)).min(1),
  hypotheses: z.array(hypothesisSchema).min(2),
  experiments: z.array(experimentEvidenceSchema).min(1),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
  }),
}).strict()

export type ExperimentCondition = z.infer<typeof experimentConditionSchema>
export type ExperimentEvidence = z.infer<typeof experimentEvidenceSchema>
export type Hypothesis = z.infer<typeof hypothesisSchema>
export type InvestigationReport = z.infer<typeof investigationReportSchema>
