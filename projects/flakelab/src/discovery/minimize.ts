import type { NetworkDelayFault } from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import type { ExperimentResult } from "./evaluate.js"
import { evaluateExperiment } from "./evaluate.js"

const MINIMUM_CONFIRMATION_TRIALS = 12

export interface DelayDiscoveryOptions {
  concurrency: number
  maximumDelayMs: number
  minimumFailureRate: number
  pattern: string
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface DelayExperiment {
  delayMs: number
  result: ExperimentResult
}

export interface DelayDiscoveryResult {
  baseline: ExperimentResult
  experiments: DelayExperiment[]
  trigger: NetworkDelayFault
  triggerResult: ExperimentResult
}

async function confirmStableDelay(
  experiments: DelayExperiment[],
  minimumDelayMs: number,
  evaluateDelay: (delayMs: number, trials?: number) => Promise<ExperimentResult>,
  confirmationTrials: number,
): Promise<{ delayMs: number; result: ExperimentResult }> {
  const candidates = [...new Set(experiments
    .filter((entry) => entry.delayMs >= minimumDelayMs && entry.result.confirmed)
    .map((entry) => entry.delayMs))]
    .sort((left, right) => left - right)
  for (const delayMs of candidates) {
    const result = await evaluateDelay(delayMs, confirmationTrials)
    if (result.confirmed) {
      return { delayMs, result }
    }
  }
  throw new Error("No network delay reproduced the failure in two independent trial batches")
}

export async function minimizeItems<T>(
  values: readonly T[],
  reproduces: (candidate: readonly T[]) => Promise<boolean>,
): Promise<T[]> {
  let minimal = [...values]
  let index = 0
  while (index < minimal.length) {
    const candidate = minimal.filter((_value, candidateIndex) => candidateIndex !== index)
    if (candidate.length > 0 && await reproduces(candidate)) {
      minimal = candidate
    } else {
      index += 1
    }
  }
  return minimal
}

export async function discoverNetworkDelay(
  execute: TrialExecutor,
  options: DelayDiscoveryOptions,
): Promise<DelayDiscoveryResult> {
  const common = {
    concurrency: options.concurrency,
    minimumFailureRate: options.minimumFailureRate,
    seed: options.seed,
    signal: options.signal,
    trials: options.trials,
  }
  const baseline = await evaluateExperiment(execute, common)
  if (baseline.failureRate > 0) {
    throw new Error("Baseline failures must be resolved before fault minimization")
  }

  const experiments: DelayExperiment[] = []
  const evaluateDelay = async (
    delayMs: number,
    trials = options.trials,
  ): Promise<ExperimentResult> => {
    const fault = { kind: "network-delay" as const, pattern: options.pattern, delayMs }
    const result = await evaluateExperiment(execute, { ...common, fault, trials })
    experiments.push({ delayMs, result })
    return result
  }

  const maximum = await evaluateDelay(options.maximumDelayMs)
  if (!maximum.confirmed) {
    throw new Error("Maximum network delay did not reproduce the failure confidently")
  }

  let passingDelayMs = 0
  let failingDelayMs = options.maximumDelayMs
  while (failingDelayMs - passingDelayMs > 1) {
    const candidate = Math.floor((passingDelayMs + failingDelayMs) / 2)
    const result = await evaluateDelay(candidate)
    if (result.confirmed) {
      failingDelayMs = candidate
    } else {
      passingDelayMs = candidate
    }
  }
  const stable = await confirmStableDelay(
    experiments,
    failingDelayMs,
    evaluateDelay,
    Math.max(options.trials, MINIMUM_CONFIRMATION_TRIALS),
  )
  return {
    baseline,
    experiments,
    trigger: { kind: "network-delay", pattern: options.pattern, delayMs: stable.delayMs },
    triggerResult: stable.result,
  }
}
