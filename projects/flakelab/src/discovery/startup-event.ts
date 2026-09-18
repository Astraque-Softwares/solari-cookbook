import type { StartupEvent, StartupEventDelayFault } from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import type { ExperimentResult } from "./evaluate.js"
import { createCausalEvaluator } from "./evaluate.js"

export interface StartupEventDiscoveryOptions {
  concurrency: number
  event: StartupEvent
  maximumDelayMs: number
  minimumFailureRate: number
  pattern: string
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface StartupEventExperiment {
  delayMs: number
  result: ExperimentResult
}

export interface StartupEventDiscoveryResult {
  baseline: ExperimentResult
  experiments: StartupEventExperiment[]
  minimumDelayMs: number
  trigger: StartupEventDelayFault
  triggerResult: ExperimentResult
}

export async function discoverStartupEventDelay(
  execute: TrialExecutor,
  options: StartupEventDiscoveryOptions,
): Promise<StartupEventDiscoveryResult> {
  const common = {
    concurrency: options.concurrency,
    minimumFailureRate: options.minimumFailureRate,
    seed: options.seed,
    signal: options.signal,
    trials: options.trials,
  }
  const evaluator = createCausalEvaluator(execute, common)

  const experiments: StartupEventExperiment[] = []
  const evaluateDelay = async (delayMs: number): Promise<ExperimentResult> => {
    const fault = {
      kind: "startup-event-delay" as const,
      delayMs,
      event: options.event,
      pattern: options.pattern,
    }
    const result = await evaluator.evaluate([fault])
    experiments.push({ delayMs, result })
    return result
  }

  const maximum = await evaluateDelay(options.maximumDelayMs)
  if (!maximum.confirmed) {
    throw new Error("Maximum startup event delay did not reproduce the failure confidently")
  }

  return {
    baseline: evaluator.baseline(),
    experiments,
    minimumDelayMs: options.maximumDelayMs,
    trigger: {
      kind: "startup-event-delay",
      delayMs: options.maximumDelayMs,
      event: options.event,
      pattern: options.pattern,
    },
    triggerResult: maximum,
  }
}
