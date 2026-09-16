import { deriveTrialSeed } from "../core/plan.js"
import type { Fault, TrialOutcome, TrialPlan } from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"

const WILSON_Z_80 = 1.281_551_565_545

export interface ExperimentOptions {
  concurrency: number
  faults: Fault[]
  minimumFailureRate: number
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface FailureSignatureResult {
  failures: number
  failureRate: number
  lowerBound80: number
  signature: string
  upperBound80: number
}

export interface CausalEffect {
  controlFailures: number
  controlRate: number
  controlUpperBound80: number
  failureRateIncrease: number
  signature: string
  treatmentFailures: number
  treatmentLowerBound80: number
  treatmentRate: number
}

export interface ExperimentResult {
  causalEffect?: CausalEffect
  confirmed: boolean
  dominantErrorReason?: string
  dominantFailureSignature?: string
  dominantFailureReason?: string
  errors: number
  failed: number
  failureRate: number
  failureSignatures: FailureSignatureResult[]
  lowerBound80: number
  passed: number
  representativeRuns: Array<{
    artifacts: NonNullable<TrialOutcome["artifacts"]>
    durationMs: number
    status: "failed" | "passed"
    trialId: string
  }>
  trials: number
  upperBound80: number
}

interface CompletedTrial {
  outcome: TrialOutcome
  plan: TrialPlan
}

export interface CausalEvaluator {
  baseline: () => ExperimentResult
  evaluate: (faults: Fault[], trials?: number) => Promise<ExperimentResult>
}

type CausalEvaluatorOptions = Omit<ExperimentOptions, "faults">

function wilsonInterval(failures: number, trials: number): {
  lowerBound80: number
  upperBound80: number
} {
  if (trials === 0) {
    return { lowerBound80: 0, upperBound80: 0 }
  }
  const probability = failures / trials
  const squaredZ = WILSON_Z_80 ** 2
  const denominator = 1 + squaredZ / trials
  const center = probability + squaredZ / (2 * trials)
  const margin = WILSON_Z_80 * Math.sqrt(
    (probability * (1 - probability) + squaredZ / (4 * trials)) / trials,
  )
  return {
    lowerBound80: Math.max(0, (center - margin) / denominator),
    upperBound80: Math.min(1, (center + margin) / denominator),
  }
}

function signatureResults(outcomes: TrialOutcome[], trials: number): FailureSignatureResult[] {
  const counts = new Map<string, number>()
  for (const outcome of outcomes) {
    if (outcome.status === "failed" && outcome.failureSignature) {
      counts.set(outcome.failureSignature, (counts.get(outcome.failureSignature) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([signature, failures]) => ({
      failures,
      failureRate: trials === 0 ? 0 : failures / trials,
      ...wilsonInterval(failures, trials),
      signature,
    }))
    .sort((left, right) =>
      right.failures - left.failures || left.signature.localeCompare(right.signature))
}

function dominantReason(outcomes: TrialOutcome[], signature?: string): string | undefined {
  return outcomes.find((outcome) =>
    outcome.failureSignature === signature && outcome.failureReason)?.failureReason
}

function validateOptions(options: CausalEvaluatorOptions): void {
  if (!Number.isInteger(options.trials) || options.trials < 2 || options.trials > 100) {
    throw new Error("experiment trials must be an integer between 2 and 100")
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32) {
    throw new Error("experiment concurrency must be an integer between 1 and 32")
  }
  if (options.minimumFailureRate <= 0 || options.minimumFailureRate > 1) {
    throw new Error("minimum failure rate must be greater than 0 and at most 1")
  }
}

async function executePlans(
  execute: TrialExecutor,
  plans: TrialPlan[],
  concurrency: number,
  signal?: AbortSignal,
): Promise<CompletedTrial[]> {
  const completed = new Map<number, CompletedTrial>()
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (!signal?.aborted) {
      const index = nextIndex
      nextIndex += 1
      const plan = plans[index]
      if (!plan) {
        return
      }
      completed.set(index, { outcome: await execute(plan), plan })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, worker))
  return [...completed.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1])
}

function summarize(
  completed: CompletedTrial[],
  minimumFailureRate: number,
): ExperimentResult {
  const outcomes = completed.map((entry) => entry.outcome)
  const failed = outcomes.filter((outcome) => outcome.status === "failed").length
  const errors = outcomes.filter((outcome) => outcome.status === "error").length
  const passed = outcomes.filter((outcome) => outcome.status === "passed").length
  const failureRate = outcomes.length === 0 ? 0 : failed / outcomes.length
  const confidence = wilsonInterval(failed, outcomes.length)
  const failureSignatures = signatureResults(outcomes, outcomes.length)
  const dominantFailureSignature = failureSignatures[0]?.signature
  const dominantErrorReason = outcomes.find((outcome) =>
    outcome.status === "error" && outcome.failureReason)?.failureReason
  const representativeRuns = (["passed", "failed"] as const).flatMap((status) => {
    const entry = completed.find((trial) => trial.outcome.status === status)
    if (!entry) {
      return []
    }
    return [{
      artifacts: entry.outcome.artifacts ?? [],
      durationMs: entry.outcome.durationMs,
      status,
      trialId: entry.plan.trialId,
    }]
  })
  return {
    confirmed:
      errors === 0
      && failureRate >= minimumFailureRate
      && confidence.lowerBound80 >= minimumFailureRate,
    dominantErrorReason,
    dominantFailureSignature,
    dominantFailureReason: dominantReason(outcomes, dominantFailureSignature),
    errors,
    failed,
    failureRate,
    failureSignatures,
    ...confidence,
    passed,
    representativeRuns,
    trials: outcomes.length,
  }
}

function causalTreatment(
  control: ExperimentResult,
  treatment: ExperimentResult,
  minimumFailureRate: number,
): ExperimentResult {
  const treatedSignature = treatment.failureSignatures[0]
  if (!treatedSignature) {
    return { ...treatment, confirmed: false }
  }
  const controlSignature = control.failureSignatures.find(
    (entry) => entry.signature === treatedSignature.signature,
  )
  const controlConfidence = controlSignature ?? {
    failures: 0,
    failureRate: 0,
    ...wilsonInterval(0, control.trials),
    signature: treatedSignature.signature,
  }
  const causalEffect: CausalEffect = {
    controlFailures: controlConfidence.failures,
    controlRate: controlConfidence.failureRate,
    controlUpperBound80: controlConfidence.upperBound80,
    failureRateIncrease: treatedSignature.failureRate - controlConfidence.failureRate,
    signature: treatedSignature.signature,
    treatmentFailures: treatedSignature.failures,
    treatmentLowerBound80: treatedSignature.lowerBound80,
    treatmentRate: treatedSignature.failureRate,
  }
  return {
    ...treatment,
    causalEffect,
    confirmed:
      control.errors === 0
      && treatment.errors === 0
      && treatedSignature.failureRate >= minimumFailureRate
      && treatedSignature.lowerBound80 >= minimumFailureRate
      && treatedSignature.lowerBound80 > controlConfidence.upperBound80,
  }
}

export async function evaluateExperiment(
  execute: TrialExecutor,
  options: ExperimentOptions,
): Promise<ExperimentResult> {
  validateOptions(options)
  const plans = Array.from({ length: options.trials }, (_, index): TrialPlan => ({
    faults: [...options.faults],
    index,
    seed: deriveTrialSeed(options.seed, index),
    trialId: `experiment-${index + 1}`,
  }))
  return summarize(
    await executePlans(execute, plans, options.concurrency, options.signal),
    options.minimumFailureRate,
  )
}

async function evaluateCausalExperiment(
  execute: TrialExecutor,
  options: ExperimentOptions,
  batch: number,
): Promise<{ control: ExperimentResult; treatment: ExperimentResult }> {
  validateOptions(options)
  const scheduled = Array.from({ length: options.trials }, (_, index) => {
    const seed = deriveTrialSeed(options.seed, index)
    const planIndex = batch * 1_000 + index * 2
    const control: TrialPlan = {
      faults: [],
      index: planIndex,
      seed,
      trialId: `batch-${batch}-control-${index + 1}`,
    }
    const treatment: TrialPlan = {
      faults: [...options.faults],
      index: planIndex + 1,
      seed,
      trialId: `batch-${batch}-intervention-${index + 1}`,
    }
    return index % 2 === 0 ? [control, treatment] : [treatment, control]
  }).flat()
  const completed = await executePlans(execute, scheduled, options.concurrency, options.signal)
  const control = summarize(
    completed.filter((entry) => entry.plan.faults.length === 0),
    options.minimumFailureRate,
  )
  const treatment = summarize(
    completed.filter((entry) => entry.plan.faults.length > 0),
    options.minimumFailureRate,
  )
  return { control, treatment: causalTreatment(control, treatment, options.minimumFailureRate) }
}

export function createCausalEvaluator(
  execute: TrialExecutor,
  options: CausalEvaluatorOptions,
): CausalEvaluator {
  let firstControl: ExperimentResult | undefined
  let batch = 0
  return {
    baseline: () => {
      if (!firstControl) {
        throw new Error("A causal intervention must run before its baseline is available")
      }
      return firstControl
    },
    evaluate: async (faults, trials = options.trials) => {
      batch += 1
      const result = await evaluateCausalExperiment(execute, { ...options, faults, trials }, batch)
      firstControl ??= result.control
      return result.treatment
    },
  }
}
