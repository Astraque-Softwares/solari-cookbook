import type {
  LoadingResourceType,
  ResourceLoadingDelayFault,
} from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import type { ExperimentResult } from "./evaluate.js"
import { createCausalEvaluator } from "./evaluate.js"

export interface ResourceLoadingDiscoveryOptions {
  concurrency: number
  maximumDelayMs: number
  minimumFailureRate: number
  pattern: string
  resourceType: LoadingResourceType
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface ResourceLoadingExperiment {
  delayMs: number
  result: ExperimentResult
}

export interface ResourceLoadingDiscoveryResult {
  baseline: ExperimentResult
  experiments: ResourceLoadingExperiment[]
  minimumDelayMs: number
  trigger: ResourceLoadingDelayFault
  triggerResult: ExperimentResult
}

export async function discoverResourceLoadingDelay(
  execute: TrialExecutor,
  options: ResourceLoadingDiscoveryOptions,
): Promise<ResourceLoadingDiscoveryResult> {
  const common = {
    concurrency: options.concurrency,
    minimumFailureRate: options.minimumFailureRate,
    seed: options.seed,
    signal: options.signal,
    trials: options.trials,
  }
  const evaluator = createCausalEvaluator(execute, common)

  const experiments: ResourceLoadingExperiment[] = []
  const evaluateDelay = async (delayMs: number): Promise<ExperimentResult> => {
    const fault = {
      kind: "resource-loading-delay" as const,
      delayMs,
      pattern: options.pattern,
      resourceType: options.resourceType,
    }
    const result = await evaluator.evaluate([fault])
    experiments.push({ delayMs, result })
    return result
  }

  const maximum = await evaluateDelay(options.maximumDelayMs)
  if (!maximum.confirmed) {
    throw new Error("Maximum resource loading delay did not reproduce the failure confidently")
  }

  return {
    baseline: evaluator.baseline(),
    experiments,
    minimumDelayMs: options.maximumDelayMs,
    trigger: {
      kind: "resource-loading-delay",
      delayMs: options.maximumDelayMs,
      pattern: options.pattern,
      resourceType: options.resourceType,
    },
    triggerResult: maximum,
  }
}
