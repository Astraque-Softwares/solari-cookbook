import type { LanguageModel } from "ai"
import { generateText, Output } from "ai"
import { z } from "zod"

import { evaluateExperiment } from "../discovery/evaluate.js"
import type { Fault } from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import { InvestigationBudget } from "./budget.js"
import { InvestigationLedger } from "./ledger.js"
import { readSafeTestContext } from "./safe-source.js"
import type { ExperimentCondition, InvestigationReport } from "./schema.js"
import { experimentConditionSchema } from "./schema.js"

const plannedHypothesisSchema = z.object({
  statement: z.string().min(8).max(500),
  prediction: z.string().min(8).max(500),
})

const investigationPlanSchema = z.object({
  hypotheses: z.array(plannedHypothesisSchema).min(2).max(3),
  experiments: z.array(z.object({
    hypothesisIndex: z.number().int().nonnegative(),
    condition: experimentConditionSchema,
  })).length(3),
})

const assessmentItemSchema = z.object({
  hypothesisId: z.string().regex(/^H\d+$/u),
  status: z.enum(["rejected", "confirmed"]),
  evidenceExperimentIds: z.array(z.string().regex(/^E\d+$/u)).min(1),
  explanation: z.string().min(8).max(1_000),
})

const assessmentSchema = z.object({
  assessments: z.array(assessmentItemSchema).min(2).max(3),
  conclusionHypothesisId: z.string().regex(/^H\d+$/u),
  conclusion: z.string().min(30).max(2_000),
  conclusionEvidenceIds: z.array(z.string().regex(/^E\d+$/u)).min(1),
})

export interface InvestigatorOptions {
  concurrency: number
  execute: TrialExecutor
  inputUsdPerMillion: number
  maxCostUsd: number
  maxExperiments: number
  maximumDelayMs: number
  maxSeconds: number
  maxSteps: number
  maxTrials: number
  minimumFailureRate: number
  model: LanguageModel
  modelId: string
  outputTokenLimit: number
  outputUsdPerMillion: number
  pattern: string
  projectRoot: string
  seed: number
  signal?: AbortSignal
  test: string
  trialsPerExperiment: number
}

function conditionToFault(condition: ExperimentCondition, pattern: string): Fault | undefined {
  if (condition.kind === "network-delay") {
    return { ...condition, pattern }
  }
  if (condition.kind === "request-failure") {
    return { ...condition, pattern }
  }
  return undefined
}

function estimatedCost(
  inputTokens: number,
  outputTokens: number,
  options: InvestigatorOptions,
): number {
  return (
    inputTokens * options.inputUsdPerMillion
    + outputTokens * options.outputUsdPerMillion
  ) / 1_000_000
}

function planningPrompt(
  test: string,
  sources: { content: string; path: string }[],
  maximumDelayMs: number,
): string {
  return [
    "You are planning a causal investigation of a flaky Playwright test.",
    "Propose two or three competing, falsifiable hypotheses and exactly three experiments.",
    "The experiment batch must contain a clean baseline, a network-delay condition, and a",
    "request-failure condition. Associate each experiment with the hypothesis it tests by",
    `zero-based hypothesisIndex. Network delay cannot exceed ${maximumDelayMs} ms.`,
    "Do not propose fixes or infer results before experiments run.",
    `Test path: ${test}`,
    "Bounded local source context:",
    ...sources.flatMap((source) => [`--- ${source.path}`, source.content]),
  ].join("\n")
}

function assessmentPrompt(ledgerState: object): string {
  return [
    "Assess this completed causal investigation using only the supplied evidence.",
    "Return one assessment for every hypothesis. Confirm exactly one hypothesis and reject",
    "at least one alternative. Confirmation requires a controlled fault that materially and",
    "confidently increased failure rate above baseline. The conclusion must describe the",
    "confirmed causal mechanism and cite only experiment IDs associated with that hypothesis.",
    JSON.stringify(ledgerState, null, 2),
  ].join("\n")
}

function validatePlan(
  plan: z.infer<typeof investigationPlanSchema>,
  options: InvestigatorOptions,
): void {
  if (plan.experiments.length > options.maxExperiments) {
    throw new Error("Model proposed more experiments than the configured budget")
  }
  if (plan.experiments.some((entry) => entry.hypothesisIndex >= plan.hypotheses.length)) {
    throw new Error("Model proposed an experiment for a missing hypothesis")
  }
  const coveredHypotheses = new Set(plan.experiments.map((entry) => entry.hypothesisIndex))
  if (plan.hypotheses.some((_hypothesis, index) => !coveredHypotheses.has(index))) {
    throw new Error("Every proposed hypothesis must receive an experiment")
  }
  if (plan.experiments.some((entry) =>
    entry.condition.kind === "network-delay"
    && entry.condition.delayMs > options.maximumDelayMs)) {
    throw new Error("Model proposed a network delay above the configured maximum")
  }
  const kinds = new Set(plan.experiments.map((entry) => entry.condition.kind))
  const requiredKinds = ["baseline", "network-delay", "request-failure"] as const
  if (!requiredKinds.every((kind) => kinds.has(kind))) {
    throw new Error("Investigation plan must distinguish baseline, timing, and request failure")
  }
}

export async function runInvestigation(options: InvestigatorOptions): Promise<InvestigationReport> {
  if (options.maxSteps < 2) {
    throw new Error("Investigation requires a budget of two model steps")
  }
  const budget = new InvestigationBudget(options)
  const timeoutSignal = AbortSignal.timeout(options.maxSeconds * 1_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  const sources = await readSafeTestContext(options.projectRoot, options.test)
  const planResult = await generateText({
    model: options.model,
    output: Output.object({ schema: investigationPlanSchema }),
    prompt: planningPrompt(options.test, sources, options.maximumDelayMs),
    maxOutputTokens: options.outputTokenLimit,
    maxRetries: 2,
    timeout: { totalMs: budget.remainingMs() },
    abortSignal: signal,
    temperature: 0.2,
  })
  const plan = planResult.output
  validatePlan(plan, options)

  const ledger = new InvestigationLedger()
  const hypotheses = plan.hypotheses.map((hypothesis) =>
    ledger.propose(hypothesis.statement, hypothesis.prediction))
  plan.experiments.forEach(() => {
    budget.reserveExperiment(options.trialsPerExperiment)
  })
  const results = await Promise.all(plan.experiments.map(async (experiment) =>
    evaluateExperiment(options.execute, {
      concurrency: options.concurrency,
      fault: conditionToFault(experiment.condition, options.pattern),
      minimumFailureRate: options.minimumFailureRate,
      seed: options.seed,
      signal,
      trials: options.trialsPerExperiment,
    })))
  const evidence = results.map((result, index) => {
    const experiment = plan.experiments[index]
    const hypothesis = hypotheses[experiment.hypothesisIndex]
    return ledger.addExperiment(hypothesis.id, experiment.condition, result)
  })

  const assessmentResult = await generateText({
    model: options.model,
    output: Output.object({ schema: assessmentSchema }),
    prompt: assessmentPrompt({ hypotheses, experiments: evidence }),
    maxOutputTokens: options.outputTokenLimit,
    maxRetries: 2,
    timeout: { totalMs: budget.remainingMs() },
    abortSignal: signal,
    temperature: 0.2,
  })
  const assessment = assessmentResult.output
  const assessedIds = new Set(assessment.assessments.map((item) => item.hypothesisId))
  if (assessedIds.size !== hypotheses.length) {
    throw new Error("Investigator must assess every proposed hypothesis exactly once")
  }
  for (const item of assessment.assessments) {
    ledger.assess(
      item.hypothesisId,
      item.status,
      item.evidenceExperimentIds,
      item.explanation,
    )
  }
  ledger.conclude(
    assessment.conclusionHypothesisId,
    assessment.conclusion,
    assessment.conclusionEvidenceIds,
  )

  const inputTokens = (planResult.usage.inputTokens ?? 0) + (assessmentResult.usage.inputTokens ?? 0)
  const outputTokens =
    (planResult.usage.outputTokens ?? 0) + (assessmentResult.usage.outputTokens ?? 0)
  const cost = estimatedCost(inputTokens, outputTokens, options)
  if (cost > budget.maxCostUsd()) {
    throw new Error(`Investigation cost $${cost.toFixed(4)} exceeded its configured budget`)
  }
  return ledger.buildReport(options.test, options.modelId, {
    inputTokens,
    outputTokens,
    estimatedCostUsd: cost,
  })
}
