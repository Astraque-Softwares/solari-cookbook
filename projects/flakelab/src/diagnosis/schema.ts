import { z } from "zod"

import { scanStatusSchema } from "../scan/schema.js"
import { portableRepositoryProfileSchema } from "../project/schema.js"

export const diagnosisStageSchema = z.enum([
  "candidate-invalid",
  "observed",
  "no-signal-observed",
  "reproducer-created",
  "investigated",
  "repair-rejected",
  "repair-proven",
])

export const diagnosisRecommendationSchema = z.object({
  aiCostLimitUsd: z.number().positive().nullable(),
  command: z.string().min(1).nullable(),
  credentials: z.array(z.enum(["GROQ_API_KEY", "SOLARI_API_KEY"])),
  expectedDuration: z.string().min(1),
  plannedTrials: z.number().int().nonnegative(),
  rationale: z.string().min(1),
  solariCostEstimateUsd: z.number().nonnegative().nullable(),
  solariCostNote: z.string().min(1),
})

export const diagnosisOptionsSchema = z.object({
  artifacts: z.string().min(1),
  baseline: z.string().min(1).nullable(),
  concurrency: z.string().min(1),
  config: z.string().min(1).optional(),
  discover: z.boolean(),
  evidence: z.string().min(1),
  html: z.string().min(1),
  investigate: z.boolean(),
  "max-cost": z.string().min(1),
  "max-delay": z.string().min(1),
  "max-experiments": z.string().min(1),
  "max-seconds": z.string().min(1),
  "max-steps": z.string().min(1),
  "max-trials": z.string().min(1),
  "min-rate": z.string().min(1),
  model: z.string().min(1),
  open: z.boolean(),
  patch: z.string().min(1),
  pattern: z.string().min(1),
  proof: z.string().min(1),
  "prompt-credentials": z.boolean(),
  repair: z.boolean(),
  report: z.string().min(1).nullable(),
  reproducer: z.string().min(1),
  runs: z.string().min(1),
  seed: z.string().min(1),
  source: z.array(z.string().min(1).max(500)).max(7),
  trials: z.string().min(1),
}).strict()

const snapshotCacheSchema = z.object({
  key: z.string().min(1).nullable(),
  reason: z.string().min(1),
  status: z.enum(["not-used", "hit", "miss"]),
})

const diagnosisUsageSchema = z.object({
  actual: z.object({
    aiEstimatedCostUsd: z.number().nonnegative(),
    aiInputTokens: z.number().int().nonnegative(),
    aiOutputTokens: z.number().int().nonnegative(),
    elapsedMilliseconds: z.number().int().nonnegative(),
    executions: z.number().int().nonnegative(),
    solariCostUsd: z.number().nonnegative().nullable(),
    solariSandboxesCreated: z.number().int().nonnegative(),
    solariSandboxesKilled: z.number().int().nonnegative(),
  }),
  planned: z.object({
    aiCostLimitUsd: z.number().positive().nullable(),
    solariCostEstimateUsd: z.number().nonnegative().nullable(),
    trials: z.number().int().nonnegative(),
  }),
})

export const diagnosisInputSchema = z.object({
  options: diagnosisOptionsSchema,
  report: z.string().min(1).nullable(),
  target: z.string().min(1).nullable(),
})

export const diagnosisArtifactSchema = z.object({
  artifacts: z.object({
    analysis: z.string().min(1).nullable(),
    discovery: z.string().min(1).nullable().default(null),
    evidence: z.string().min(1).nullable(),
    html: z.string().min(1).nullable(),
    patch: z.string().min(1).nullable(),
    proof: z.string().min(1).nullable(),
    reproducer: z.string().min(1).nullable(),
    scan: z.string().min(1).nullable(),
  }),
  cache: snapshotCacheSchema,
  candidateGeneration: z.object({
    artifactPaths: z.array(z.string().min(1).max(1_000)).max(6),
    attemptCount: z.number().int().min(1).max(2),
    attempts: z.array(z.object({
      artifactPaths: z.object({
        candidate: z.string().min(1).max(1_000),
        diff: z.string().min(1).max(1_000).nullable(),
        validation: z.string().min(1).max(1_000),
      }),
      attempt: z.number().int().min(1).max(2),
      candidatePath: z.string().min(1).max(500).nullable(),
      diffRendered: z.boolean(),
      outcome: z.enum(["candidate-invalid", "pending", "valid"]),
      rejection: z.object({
        attempt: z.number().int().min(1).max(2),
        candidatePath: z.string().min(1).max(500).optional(),
        code: z.string().min(1),
        correctiveAttemptPermitted: z.boolean(),
        diffRendered: z.boolean(),
        message: z.string().min(1).max(2_000),
      }).nullable(),
      usage: z.object({
        estimatedCostUsd: z.number().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      }),
    })).min(1).max(2),
    correctiveAttemptOccurred: z.boolean(),
    finalRejection: z.object({
      attempt: z.number().int().min(1).max(2),
      candidatePath: z.string().min(1).max(500).optional(),
      code: z.string().min(1),
      correctiveAttemptPermitted: z.boolean(),
      diffRendered: z.boolean(),
      message: z.string().min(1).max(2_000),
    }).nullable(),
    usage: z.object({
      estimatedCostUsd: z.number().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
  }).nullable().default(null),
  cleanup: z.object({
    liveResources: z.number().int().nonnegative().nullable(),
    status: z.enum(["confirmed", "not-required", "unconfirmed"]),
  }),
  createdAt: z.iso.datetime(),
  input: diagnosisInputSchema,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  lastError: z.string().min(1).max(2_000).nullable(),
  observation: z.object({
    elapsedMilliseconds: z.number().int().nonnegative(),
    executions: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    status: scanStatusSchema,
    tests: z.number().int().nonnegative(),
  }),
  recommendation: diagnosisRecommendationSchema,
  repository: portableRepositoryProfileSchema.optional(),
  stage: diagnosisStageSchema,
  status: z.enum(["complete", "failed", "interrupted", "running"]),
  updatedAt: z.iso.datetime(),
  usage: diagnosisUsageSchema,
})

export type DiagnosisArtifact = z.infer<typeof diagnosisArtifactSchema>
export type DiagnosisCheckpointOptions = z.infer<typeof diagnosisOptionsSchema>
export type DiagnosisRecommendation = z.infer<typeof diagnosisRecommendationSchema>
export type DiagnosisStage = z.infer<typeof diagnosisStageSchema>
