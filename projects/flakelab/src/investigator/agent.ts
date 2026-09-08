import type { LanguageModel } from "ai"
import { generateText, NoObjectGeneratedError, Output } from "ai"

import { evaluateExperiment } from "../discovery/evaluate.js"
import type { ExperimentResult } from "../discovery/evaluate.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import {
  applyInvestigationAssessment,
  type AssessmentGeneration,
  generateValidInvestigationAssessment,
  groundAssessmentInEvidence,
  investigationAssessmentSchema,
  type InvestigationAssessment,
  validateExperimentEvidence,
} from "./assessment.js"
import { InvestigationBudget } from "./budget.js"
import { RecoverableGenerationError } from "./generation.js"
import { InvestigationLedger } from "./ledger.js"
import {
  generateValidInvestigationPlan,
  investigationPlanSchema,
  sameExperimentCondition,
  type InvestigationPlan,
  type PlanGeneration,
} from "./planning.js"
import { readSafeTestContext } from "./safe-source.js"
import type {
  ExperimentCondition,
  ExperimentEvidence,
  Hypothesis,
  InvestigationReport,
} from "./schema.js"
import { conditionToFaults } from "./targeting.js"

interface LedgerState {
  evidence: ExperimentEvidence[]
  hypotheses: Hypothesis[]
  ledger: InvestigationLedger
}

export interface RequiredExperimentEvidence {
  condition: ExperimentCondition
  result: ExperimentResult
}

export async function collectInvestigationResults(
  plan: InvestigationPlan,
  requiredEvidence: RequiredExperimentEvidence | undefined,
  evaluate: (condition: ExperimentCondition) => Promise<ExperimentResult>,
): Promise<ExperimentResult[]> {
  return Promise.all(plan.experiments.map(({ condition }) => {
    if (requiredEvidence && sameExperimentCondition(condition, requiredEvidence.condition)) {
      return Promise.resolve(requiredEvidence.result)
    }
    return evaluate(condition)
  }))
}

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
  requiredEvidence?: RequiredExperimentEvidence
  seed: number
  signal?: AbortSignal
  test: string
  trialsPerExperiment: number
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

function enforceCostBudget(
  inputTokens: number,
  outputTokens: number,
  options: InvestigatorOptions,
  budget: InvestigationBudget,
): number {
  const cost = estimatedCost(inputTokens, outputTokens, options)
  if (cost > budget.maxCostUsd()) {
    throw new Error(`Investigation cost $${cost.toFixed(4)} exceeded its configured budget`)
  }
  return cost
}

function planningPrompt(
  test: string,
  sources: { content: string; path: string }[],
  maximumDelayMs: number,
  requiredCondition?: ExperimentCondition,
): string {
  return [
    "You are planning a causal investigation of a flaky Playwright test.",
    "Propose exactly two competing, falsifiable hypotheses and exactly three experiments.",
    "The experiment batch must contain a clean baseline and one different intervention for each",
    "hypothesis, chosen",
    "from network delay, request failure, response truncation, response duplication, and response",
    "reordering, resource loading delay, startup event delay, a bounded event-loop stall, named",
    "auth-cookie expiry, delayed visibility of a named local/session-storage entry, a bounded",
    "wall-clock jump, a BCP 47 locale, an IANA timezone, a bounded viewport, reduced motion,",
    "animation playback speed between 0.1x and 10x, 2-16 parallel workers, and 2-16",
    "overlapping copies of the selected test for shared-state interference.",
    "Reordering holds the first response",
    "in each adjacent matching request pair. Startup event delay postpones application listeners for",
    "DOMContentLoaded or load. Resource loading targets document, script, stylesheet, image, or font.",
    "Never request or include cookie or storage values; only names and keys are allowed.",
    "Clock jumps change Date wall time without changing monotonic timers.",
    "Response truncation and duplication cannot alter more than 1024 bytes. Associate each",
    "experiment with the hypothesis it tests by",
    `zero-based hypothesisIndex. Network, resource loading, startup event delays, and event-loop stall duration cannot exceed ${maximumDelayMs} ms.`,
    "Do not propose fixes or infer results before experiments run.",
    ...(requiredCondition
      ? [`One intervention must repeat this trigger already confirmed by discovery: ${JSON.stringify(requiredCondition)}`]
      : []),
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
    "confidently increased failure rate above baseline. Return hypothesis IDs, statuses, and",
    "explanations only; FlakeLab binds the measured experiment evidence deterministically.",
    "The conclusion must identify and describe the confirmed causal mechanism.",
    JSON.stringify(ledgerState, null, 2),
  ].join("\n")
}

function assessmentRepairPrompt(
  ledgerState: object,
  previous: InvestigationAssessment,
  validationError: string,
): string {
  return [
    assessmentPrompt(ledgerState),
    "Your previous assessment was rejected by the deterministic evidence validator.",
    `Validation error: ${validationError}`,
    "Previous invalid assessment:",
    JSON.stringify(previous, null, 2),
    "Return one corrected assessment. Do not change or invent experiment results.",
  ].join("\n")
}

function createLedgerState(plan: InvestigationPlan, results: ExperimentResult[]): LedgerState {
  const ledger = new InvestigationLedger()
  const hypotheses = plan.hypotheses.map((hypothesis) =>
    ledger.propose(hypothesis.statement, hypothesis.prediction))
  const evidence = results.map((result, index) => {
    const experiment = plan.experiments[index]
    const hypothesis = hypotheses[experiment.hypothesisIndex]
    return ledger.addExperiment(hypothesis.id, experiment.condition, result)
  })
  return { evidence, hypotheses, ledger }
}

export async function runInvestigation(options: InvestigatorOptions): Promise<InvestigationReport> {
  if (options.maxSteps < 2) {
    throw new Error("Investigation requires a budget of two model steps")
  }
  const budget = new InvestigationBudget(options)
  const timeoutSignal = AbortSignal.timeout(options.maxSeconds * 1_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  const sources = await readSafeTestContext(options.projectRoot, options.test)
  const planResult = await generateValidInvestigationPlan({
    generate: async (prompt, temperature): Promise<PlanGeneration> => {
      try {
        const result = await generateText({
          model: options.model,
          output: Output.object({ schema: investigationPlanSchema }),
          prompt,
          maxOutputTokens: options.outputTokenLimit,
          maxRetries: 2,
          timeout: { totalMs: budget.remainingMs() },
          abortSignal: signal,
          temperature,
        })
        return {
          output: result.output,
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
          },
        }
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error)) {
          throw new RecoverableGenerationError(error.message, error.text, {
            inputTokens: error.usage?.inputTokens ?? 0,
            outputTokens: error.usage?.outputTokens ?? 0,
          })
        }
        throw error
      }
    },
    initialPrompt: planningPrompt(
      options.test,
      sources,
      options.maximumDelayMs,
      options.requiredEvidence?.condition,
    ),
    maxAttempts: Math.min(2, options.maxSteps - 1),
    rules: {
      maxExperiments: options.maxExperiments,
      maximumDelayMs: options.maximumDelayMs,
      ...(options.requiredEvidence
        ? { requiredCondition: options.requiredEvidence.condition }
        : {}),
    },
  })
  const plan = planResult.plan
  let modelSteps = planResult.attempts.length
  const planningInputTokens = planResult.attempts.reduce(
    (total, usage) => total + usage.inputTokens,
    0,
  )
  const planningOutputTokens = planResult.attempts.reduce(
    (total, usage) => total + usage.outputTokens,
    0,
  )
  enforceCostBudget(planningInputTokens, planningOutputTokens, options, budget)

  const results = await collectInvestigationResults(
    plan,
    options.requiredEvidence,
    async (condition) => {
      budget.reserveExperiment(options.trialsPerExperiment)
      return evaluateExperiment(options.execute, {
        concurrency: options.concurrency,
        faults: conditionToFaults(condition, options.pattern, options.test),
        minimumFailureRate: options.minimumFailureRate,
        seed: options.seed,
        signal,
        trials: options.trialsPerExperiment,
      })
    },
  )
  let state = createLedgerState(plan, results)
  validateExperimentEvidence(state.evidence)

  const ledgerState = { hypotheses: state.hypotheses, experiments: state.evidence }
  const generateAssessment = async (
    prompt: string,
    temperature: number,
  ): Promise<AssessmentGeneration> => {
    try {
      const result = await generateText({
        model: options.model,
        output: Output.object({ schema: investigationAssessmentSchema }),
        prompt,
        maxOutputTokens: options.outputTokenLimit,
        maxRetries: 2,
        timeout: { totalMs: budget.remainingMs() },
        abortSignal: signal,
        temperature,
      })
      return {
        output: result.output,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      }
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        throw new RecoverableGenerationError(error.message, error.text, {
          inputTokens: error.usage?.inputTokens ?? 0,
          outputTokens: error.usage?.outputTokens ?? 0,
        })
      }
      throw error
    }
  }
  const assessmentAttempts: AssessmentGeneration["usage"][] = []
  if (options.requiredEvidence) {
    applyInvestigationAssessment(
      state,
      groundAssessmentInEvidence(state),
    )
  } else {
    const assessmentResult = await generateValidInvestigationAssessment({
      generate: generateAssessment,
      initialPrompt: assessmentPrompt(ledgerState),
      maxAttempts: Math.min(2, options.maxSteps - modelSteps),
    })
    modelSteps += assessmentResult.attempts.length
    assessmentAttempts.push(...assessmentResult.attempts)
    try {
      applyInvestigationAssessment(
        state,
        groundAssessmentInEvidence(state, assessmentResult.assessment),
      )
    } catch (error) {
      if (modelSteps >= options.maxSteps) {
        throw error
      }
      const validationError = error instanceof Error ? error.message : "invalid evidence assessment"
      const repairResult = await generateValidInvestigationAssessment({
        generate: generateAssessment,
        initialPrompt: assessmentRepairPrompt(
          ledgerState,
          assessmentResult.assessment,
          validationError,
        ),
        temperature: 0,
        maxAttempts: Math.min(2, options.maxSteps - modelSteps),
      })
      assessmentAttempts.push(...repairResult.attempts)
      state = createLedgerState(plan, results)
      applyInvestigationAssessment(
        state,
        groundAssessmentInEvidence(state, repairResult.assessment),
      )
    }
  }

  const inputTokens = planningInputTokens + assessmentAttempts.reduce(
    (total, usage) => total + usage.inputTokens,
    0,
  )
  const outputTokens = planningOutputTokens + assessmentAttempts.reduce(
    (total, usage) => total + usage.outputTokens,
    0,
  )
  const cost = enforceCostBudget(inputTokens, outputTokens, options, budget)
  return state.ledger.buildReport(options.test, options.modelId, sources.map((source) => source.path), {
    inputTokens,
    outputTokens,
    estimatedCostUsd: cost,
  })
}
