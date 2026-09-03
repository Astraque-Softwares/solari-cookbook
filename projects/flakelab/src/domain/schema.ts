import { z } from "zod"

export const networkDelayFaultSchema = z.object({
  kind: z.literal("network-delay"),
  pattern: z.string().min(1),
  delayMs: z.number().int().min(1).max(30_000),
})

export const requestFailureFaultSchema = z.object({
  kind: z.literal("request-failure"),
  pattern: z.string().min(1),
  statusCode: z.number().int().min(400).max(599),
})

export const faultSchema = z.discriminatedUnion("kind", [
  networkDelayFaultSchema,
  requestFailureFaultSchema,
])

export const runRequestSchema = z.object({
  selector: z.string().min(1),
  runs: z.number().int().min(2).max(100),
  seed: z.number().int().min(0).max(0xffff_ffff),
  artifactDirectory: z.string().min(1),
  fault: faultSchema,
})

export const trialPlanSchema = z.object({
  trialId: z.string().min(1),
  index: z.number().int().nonnegative(),
  seed: z.number().int().min(0).max(0xffff_ffff),
  fault: faultSchema.optional(),
})

export const trialOutcomeSchema = z.object({
  status: z.enum(["passed", "failed", "error"]),
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  failureSignature: z.string().min(1).optional(),
  failureReason: z.string().min(1).max(2_000).optional(),
})

export const runSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  baselineFailureRate: z.number().min(0).max(1),
  faultFailureRate: z.number().min(0).max(1),
})

const eventBaseSchema = z.object({
  runId: z.string().min(1),
  timestamp: z.iso.datetime(),
})

export const runEventSchema = z.discriminatedUnion("type", [
  eventBaseSchema.extend({
    type: z.literal("run.started"),
    request: runRequestSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal("trial.started"),
    trial: trialPlanSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal("trial.completed"),
    trial: trialPlanSchema,
    outcome: trialOutcomeSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal("run.completed"),
    summary: runSummarySchema,
  }),
])

export type Fault = z.infer<typeof faultSchema>
export type NetworkDelayFault = z.infer<typeof networkDelayFaultSchema>
export type RequestFailureFault = z.infer<typeof requestFailureFaultSchema>
export type RunEvent = z.infer<typeof runEventSchema>
export type RunRequest = z.infer<typeof runRequestSchema>
export type RunSummary = z.infer<typeof runSummarySchema>
export type TrialOutcome = z.infer<typeof trialOutcomeSchema>
export type TrialPlan = z.infer<typeof trialPlanSchema>
