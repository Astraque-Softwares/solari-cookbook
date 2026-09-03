import { deriveTrialSeed } from "../core/plan.js"
import type { Fault, TrialOutcome, TrialPlan } from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"

const WILSON_Z_80 = 1.281_551_565_545

export interface ExperimentOptions {
  concurrency: number
  fault?: Fault
  minimumFailureRate: number
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface ExperimentResult {
  confirmed: boolean
  dominantFailureSignature?: string
  dominantFailureReason?: string
  errors: number
  failed: number
  failureRate: number
  lowerBound80: number
  passed: number
  trials: number
}

function lowerWilsonBound(failures: number, trials: number): number {
  if (trials === 0) {
    return 0
  }
  const probability = failures / trials
  const squaredZ = WILSON_Z_80 ** 2
  const denominator = 1 + squaredZ / trials
  const center = probability + squaredZ / (2 * trials)
  const margin = WILSON_Z_80 * Math.sqrt(
    (probability * (1 - probability) + squaredZ / (4 * trials)) / trials,
  )
  return Math.max(0, (center - margin) / denominator)
}

function dominantSignature(outcomes: TrialOutcome[]): string | undefined {
  const counts = new Map<string, number>()
  for (const outcome of outcomes) {
    if (outcome.status === "failed" && outcome.failureSignature) {
      counts.set(outcome.failureSignature, (counts.get(outcome.failureSignature) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
}

function dominantReason(outcomes: TrialOutcome[], signature?: string): string | undefined {
  return outcomes.find((outcome) =>
    outcome.failureSignature === signature && outcome.failureReason)?.failureReason
}

function validateOptions(options: ExperimentOptions): void {
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

export async function evaluateExperiment(
  execute: TrialExecutor,
  options: ExperimentOptions,
): Promise<ExperimentResult> {
  validateOptions(options)
  const plans = Array.from({ length: options.trials }, (_, index): TrialPlan => ({
    trialId: `experiment-${index + 1}`,
    index,
    seed: deriveTrialSeed(options.seed, index),
    fault: options.fault,
  }))
  const outcomes = new Map<number, TrialOutcome>()
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (!options.signal?.aborted) {
      const index = nextIndex
      nextIndex += 1
      if (index >= plans.length) {
        return
      }
      outcomes.set(index, await execute(plans[index]))
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(options.concurrency, plans.length) },
    worker,
  ))
  const completed = [...outcomes.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1])
  const failed = completed.filter((outcome) => outcome.status === "failed").length
  const errors = completed.filter((outcome) => outcome.status === "error").length
  const passed = completed.filter((outcome) => outcome.status === "passed").length
  const failureRate = completed.length === 0 ? 0 : failed / completed.length
  const lowerBound80 = lowerWilsonBound(failed, completed.length)
  const dominantFailureSignature = dominantSignature(completed)
  return {
    confirmed:
      errors === 0
      && failureRate >= options.minimumFailureRate
      && lowerBound80 >= options.minimumFailureRate,
    dominantFailureSignature,
    dominantFailureReason: dominantReason(completed, dominantFailureSignature),
    errors,
    failed,
    failureRate,
    lowerBound80,
    passed,
    trials: completed.length,
  }
}
