import { isDeepStrictEqual } from "node:util"
import { z } from "zod"

import {
  type ModelGenerationUsage,
  RecoverableGenerationError,
  schemaCorrectionPrompt,
} from "./generation.js"
import { experimentConditionSchema } from "./schema.js"

const plannedHypothesisSchema = z.object({
  statement: z.string().min(8).max(500),
  prediction: z.string().min(8).max(500),
})

export const investigationPlanSchema = z.object({
  hypotheses: z.array(plannedHypothesisSchema).length(2),
  experiments: z.array(z.object({
    hypothesisIndex: z.number().int().nonnegative(),
    condition: experimentConditionSchema,
  })).length(3),
})

export type InvestigationPlan = z.infer<typeof investigationPlanSchema>

export interface PlanGeneration {
  output: InvestigationPlan
  usage: ModelGenerationUsage
}

interface PlanRules {
  maxExperiments: number
  maximumDelayMs: number
  requiredCondition?: z.infer<typeof experimentConditionSchema>
}

interface GenerateValidPlanOptions {
  generate: (prompt: string, temperature: number) => Promise<PlanGeneration>
  initialPrompt: string
  maxAttempts: number
  rules: PlanRules
}

export interface ValidPlanResult {
  attempts: ModelGenerationUsage[]
  generations: PlanGeneration[]
  plan: InvestigationPlan
}

function conditionKinds(plan: InvestigationPlan): string[] {
  return plan.experiments.map((entry) => entry.condition.kind)
}

export function sameExperimentCondition(
  left: z.infer<typeof experimentConditionSchema>,
  right: z.infer<typeof experimentConditionSchema>,
): boolean {
  return isDeepStrictEqual(left, right)
}

function validateRequiredCondition(
  plan: InvestigationPlan,
  requiredCondition?: z.infer<typeof experimentConditionSchema>,
): void {
  if (requiredCondition && !plan.experiments.some((entry) =>
    sameExperimentCondition(entry.condition, requiredCondition))) {
    throw new Error(
      `Investigation plan must include the discovered ${requiredCondition.kind} intervention exactly`,
    )
  }
}

export function validateInvestigationPlan(plan: InvestigationPlan, rules: PlanRules): void {
  if (plan.experiments.length > rules.maxExperiments) {
    throw new Error("Model proposed more experiments than the configured budget")
  }
  if (plan.experiments.some((entry) => entry.hypothesisIndex >= plan.hypotheses.length)) {
    throw new Error("Model proposed an experiment for a missing hypothesis")
  }
  const coveredHypotheses = new Set(plan.experiments.map((entry) => entry.hypothesisIndex))
  if (plan.hypotheses.some((_hypothesis, index) => !coveredHypotheses.has(index))) {
    throw new Error("Every proposed hypothesis must receive an experiment")
  }
  if (plan.hypotheses.some((_hypothesis, index) => !plan.experiments.some((entry) =>
    entry.hypothesisIndex === index && entry.condition.kind !== "baseline"))) {
    throw new Error("Every proposed hypothesis must receive a non-baseline intervention")
  }
  const excessiveDelay = plan.experiments.some((entry) =>
    (entry.condition.kind === "network-delay"
      || entry.condition.kind === "resource-loading-delay"
      || entry.condition.kind === "startup-event-delay"
      || entry.condition.kind === "storage-state-delay")
    && entry.condition.delayMs > rules.maximumDelayMs)
  if (excessiveDelay) {
    throw new Error("Model proposed a delay above the configured maximum")
  }
  const excessiveStall = plan.experiments.some((entry) =>
    entry.condition.kind === "event-loop-stall"
    && entry.condition.durationMs > rules.maximumDelayMs)
  if (excessiveStall) {
    throw new Error("Model proposed an event-loop stall above the configured maximum")
  }
  const kinds = conditionKinds(plan)
  if (!kinds.includes("baseline") || new Set(kinds).size !== 3) {
    throw new Error(
      "Investigation plan must contain one baseline and two distinct interventions;"
      + ` received ${kinds.join(", ")}`,
    )
  }
  validateRequiredCondition(plan, rules.requiredCondition)
}

function repairPrompt(
  initialPrompt: string,
  invalidPlan: InvestigationPlan,
  validationError: string,
): string {
  return [
    initialPrompt,
    "Your previous plan passed the output schema but failed deterministic validation.",
    `Validation error: ${validationError}`,
    "Previous invalid plan:",
    JSON.stringify(invalidPlan, null, 2),
    "Return one corrected plan with exactly one baseline and two different intervention kinds.",
    "Keep exactly three experiments, cover every hypothesis, and do not repeat a condition kind.",
  ].join("\n")
}

function recoverSchemaFailure(
  error: Error,
  options: GenerateValidPlanOptions,
  attempt: number,
  attempts: ModelGenerationUsage[],
): string {
  if (!(error instanceof RecoverableGenerationError)) {
    throw error
  }
  attempts.push(error.usage)
  if (attempt + 1 >= options.maxAttempts) {
    throw error
  }
  return schemaCorrectionPrompt(
    options.initialPrompt,
    error,
    "hypotheses (exactly 2) and experiments (exactly 3)",
  )
}

function asGenerationError<T>(error: T): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error("Investigation plan generation failed without an error message", {
    cause: error,
  })
}

export async function generateValidInvestigationPlan(
  options: GenerateValidPlanOptions,
): Promise<ValidPlanResult> {
  const attempts: ModelGenerationUsage[] = []
  const generations: PlanGeneration[] = []
  let prompt = options.initialPrompt
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    let generated: PlanGeneration
    try {
      generated = await options.generate(prompt, attempt === 0 ? 0.2 : 0)
    } catch (error) {
      prompt = recoverSchemaFailure(asGenerationError(error), options, attempt, attempts)
      continue
    }
    attempts.push(generated.usage)
    generations.push(generated)
    try {
      validateInvestigationPlan(generated.output, options.rules)
      return { attempts, generations, plan: generated.output }
    } catch (error) {
      if (attempt + 1 >= options.maxAttempts) {
        throw error
      }
      const message = error instanceof Error ? error.message : "invalid investigation plan"
      prompt = repairPrompt(options.initialPrompt, generated.output, message)
    }
  }
  throw new Error("Investigation plan generation exhausted its attempt budget")
}
