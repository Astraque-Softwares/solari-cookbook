import { z } from "zod"

export const experimentResultSchema = z.object({
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

export const experimentConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("baseline") }),
  z.object({
    kind: z.literal("network-delay"),
    delayMs: z.number().int().min(1).max(30_000),
  }),
  z.object({
    kind: z.literal("request-failure"),
    statusCode: z.number().int().min(400).max(599),
  }),
])

export const hypothesisSchema = z.object({
  id: z.string().regex(/^H\d+$/u),
  statement: z.string().min(8).max(500),
  prediction: z.string().min(8).max(500),
  status: z.enum(["proposed", "rejected", "confirmed"]),
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
  version: z.literal(1),
  test: z.string().min(1),
  model: z.string().min(1),
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
})

export type ExperimentCondition = z.infer<typeof experimentConditionSchema>
export type ExperimentEvidence = z.infer<typeof experimentEvidenceSchema>
export type Hypothesis = z.infer<typeof hypothesisSchema>
export type InvestigationReport = z.infer<typeof investigationReportSchema>
