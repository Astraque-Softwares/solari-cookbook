import type { BrowserStorageArea, StorageStateDelayFault } from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import type { ExperimentResult } from "./evaluate.js"
import { createCausalEvaluator } from "./evaluate.js"

export interface StorageStateDiscoveryOptions {
  concurrency: number
  key: string
  maximumDelayMs: number
  minimumFailureRate: number
  pattern: string
  seed: number
  signal?: AbortSignal
  storage: BrowserStorageArea
  trials: number
}

export interface StorageStateExperiment {
  delayMs: number
  result: ExperimentResult
}

export interface StorageStateDiscoveryResult {
  baseline: ExperimentResult
  experiments: StorageStateExperiment[]
  minimumDelayMs: number
  trigger: StorageStateDelayFault
  triggerResult: ExperimentResult
}

export async function discoverStorageStateDelay(
  execute: TrialExecutor,
  options: StorageStateDiscoveryOptions,
): Promise<StorageStateDiscoveryResult> {
  const common = {
    concurrency: options.concurrency,
    minimumFailureRate: options.minimumFailureRate,
    seed: options.seed,
    signal: options.signal,
    trials: options.trials,
  }
  const evaluator = createCausalEvaluator(execute, common)
  const experiments: StorageStateExperiment[] = []
  const evaluateDelay = async (delayMs: number): Promise<ExperimentResult> => {
    const fault: StorageStateDelayFault = {
      kind: "storage-state-delay",
      delayMs,
      key: options.key,
      pattern: options.pattern,
      storage: options.storage,
    }
    const result = await evaluator.evaluate([fault])
    experiments.push({ delayMs, result })
    return result
  }
  const maximum = await evaluateDelay(options.maximumDelayMs)
  if (!maximum.confirmed) {
    throw new Error("Maximum storage-state delay did not reproduce the failure confidently")
  }
  return {
    baseline: evaluator.baseline(),
    experiments,
    minimumDelayMs: options.maximumDelayMs,
    trigger: {
      kind: "storage-state-delay",
      delayMs: options.maximumDelayMs,
      key: options.key,
      pattern: options.pattern,
      storage: options.storage,
    },
    triggerResult: maximum,
  }
}
