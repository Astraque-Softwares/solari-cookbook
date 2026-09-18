import type {
  NetworkDelayFault,
  ResponseDuplicationFault,
  ResponseReorderingFault,
  ResponseTruncationFault,
} from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import type { ExperimentResult } from "./evaluate.js"
import { createCausalEvaluator } from "./evaluate.js"

export function networkDelayTrialBound(_trials: number, _maximumDelayMs: number): number {
  return 16
}

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

export interface TruncationDiscoveryOptions {
  concurrency: number
  maximumRemoveBytes: number
  minimumFailureRate: number
  pattern: string
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface TruncationExperiment {
  removeBytes: number
  result: ExperimentResult
}

export interface TruncationDiscoveryResult {
  baseline: ExperimentResult
  experiments: TruncationExperiment[]
  trigger: ResponseTruncationFault
  triggerResult: ExperimentResult
}

export interface DuplicationDiscoveryOptions {
  concurrency: number
  maximumDuplicateBytes: number
  minimumFailureRate: number
  pattern: string
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface DuplicationExperiment {
  duplicateBytes: number
  result: ExperimentResult
}

export interface DuplicationDiscoveryResult {
  baseline: ExperimentResult
  experiments: DuplicationExperiment[]
  trigger: ResponseDuplicationFault
  triggerResult: ExperimentResult
}

export interface ReorderingDiscoveryOptions {
  concurrency: number
  maximumHoldMs: number
  minimumFailureRate: number
  pattern: string
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface ReorderingExperiment {
  holdMs: number
  result: ExperimentResult
}

export interface ReorderingDiscoveryResult {
  baseline: ExperimentResult
  experiments: ReorderingExperiment[]
  trigger: ResponseReorderingFault
  triggerResult: ExperimentResult
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
  const evaluator = createCausalEvaluator(execute, common)

  const experiments: DelayExperiment[] = []
  const evaluateDelay = async (delayMs: number): Promise<ExperimentResult> => {
    const fault = { kind: "network-delay" as const, pattern: options.pattern, delayMs }
    const result = await evaluator.evaluate([fault])
    experiments.push({ delayMs, result })
    return result
  }

  const maximum = await evaluateDelay(options.maximumDelayMs)
  if (!maximum.confirmed) {
    throw new Error("Maximum network delay did not reproduce the failure confidently")
  }

  return {
    baseline: evaluator.baseline(),
    experiments,
    trigger: {
      kind: "network-delay",
      pattern: options.pattern,
      delayMs: options.maximumDelayMs,
    },
    triggerResult: maximum,
  }
}

export async function discoverResponseTruncation(
  execute: TrialExecutor,
  options: TruncationDiscoveryOptions,
): Promise<TruncationDiscoveryResult> {
  const common = {
    concurrency: options.concurrency,
    minimumFailureRate: options.minimumFailureRate,
    seed: options.seed,
    signal: options.signal,
    trials: options.trials,
  }
  const evaluator = createCausalEvaluator(execute, common)

  const experiments: TruncationExperiment[] = []
  const evaluateRemoval = async (removeBytes: number): Promise<ExperimentResult> => {
    const fault = {
      kind: "response-truncation" as const,
      pattern: options.pattern,
      removeBytes,
    }
    const result = await evaluator.evaluate([fault])
    experiments.push({ removeBytes, result })
    return result
  }

  const maximum = await evaluateRemoval(options.maximumRemoveBytes)
  if (!maximum.confirmed) {
    throw new Error("Maximum response truncation did not reproduce the failure confidently")
  }

  return {
    baseline: evaluator.baseline(),
    experiments,
    trigger: {
      kind: "response-truncation",
      pattern: options.pattern,
      removeBytes: options.maximumRemoveBytes,
    },
    triggerResult: maximum,
  }
}

export async function discoverResponseDuplication(
  execute: TrialExecutor,
  options: DuplicationDiscoveryOptions,
): Promise<DuplicationDiscoveryResult> {
  const common = {
    concurrency: options.concurrency,
    minimumFailureRate: options.minimumFailureRate,
    seed: options.seed,
    signal: options.signal,
    trials: options.trials,
  }
  const evaluator = createCausalEvaluator(execute, common)

  const experiments: DuplicationExperiment[] = []
  const evaluateDuplication = async (duplicateBytes: number): Promise<ExperimentResult> => {
    const fault = {
      kind: "response-duplication" as const,
      pattern: options.pattern,
      duplicateBytes,
    }
    const result = await evaluator.evaluate([fault])
    experiments.push({ duplicateBytes, result })
    return result
  }

  const maximum = await evaluateDuplication(options.maximumDuplicateBytes)
  if (!maximum.confirmed) {
    throw new Error("Maximum response duplication did not reproduce the failure confidently")
  }

  return {
    baseline: evaluator.baseline(),
    experiments,
    trigger: {
      kind: "response-duplication",
      pattern: options.pattern,
      duplicateBytes: options.maximumDuplicateBytes,
    },
    triggerResult: maximum,
  }
}

export async function discoverResponseReordering(
  execute: TrialExecutor,
  options: ReorderingDiscoveryOptions,
): Promise<ReorderingDiscoveryResult> {
  const common = {
    concurrency: options.concurrency,
    minimumFailureRate: options.minimumFailureRate,
    seed: options.seed,
    signal: options.signal,
    trials: options.trials,
  }
  const evaluator = createCausalEvaluator(execute, common)

  const experiments: ReorderingExperiment[] = []
  const evaluateHold = async (holdMs: number): Promise<ExperimentResult> => {
    const fault = { kind: "response-reordering" as const, pattern: options.pattern, holdMs }
    const result = await evaluator.evaluate([fault])
    experiments.push({ holdMs, result })
    return result
  }

  const maximum = await evaluateHold(options.maximumHoldMs)
  if (!maximum.confirmed) {
    throw new Error("Maximum response hold did not reproduce the failure confidently")
  }

  return {
    baseline: evaluator.baseline(),
    experiments,
    trigger: {
      kind: "response-reordering",
      pattern: options.pattern,
      holdMs: options.maximumHoldMs,
    },
    triggerResult: maximum,
  }
}
