import type { EventLoopStallFault } from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import type { ExperimentResult } from "./evaluate.js"
import { createCausalEvaluator } from "./evaluate.js"

export interface EventLoopDiscoveryOptions {
  concurrency: number
  maximumDurationMs: number
  minimumFailureRate: number
  pattern: string
  seed: number
  signal?: AbortSignal
  startAfterMs: number
  trials: number
}

export interface EventLoopExperiment {
  durationMs: number
  result: ExperimentResult
}

export interface EventLoopDiscoveryResult {
  baseline: ExperimentResult
  experiments: EventLoopExperiment[]
  minimumDurationMs: number
  trigger: EventLoopStallFault
  triggerResult: ExperimentResult
}

export async function discoverEventLoopStall(
  execute: TrialExecutor,
  options: EventLoopDiscoveryOptions,
): Promise<EventLoopDiscoveryResult> {
  const common = {
    concurrency: options.concurrency,
    minimumFailureRate: options.minimumFailureRate,
    seed: options.seed,
    signal: options.signal,
    trials: options.trials,
  }
  const evaluator = createCausalEvaluator(execute, common)

  const experiments: EventLoopExperiment[] = []
  const evaluateDuration = async (durationMs: number): Promise<ExperimentResult> => {
    const fault = {
      kind: "event-loop-stall" as const,
      durationMs,
      pattern: options.pattern,
      startAfterMs: options.startAfterMs,
    }
    const result = await evaluator.evaluate([fault])
    experiments.push({ durationMs, result })
    return result
  }

  const maximum = await evaluateDuration(options.maximumDurationMs)
  if (!maximum.confirmed) {
    throw new Error("Maximum event-loop stall did not reproduce the failure confidently")
  }

  return {
    baseline: evaluator.baseline(),
    experiments,
    minimumDurationMs: options.maximumDurationMs,
    trigger: {
      kind: "event-loop-stall",
      durationMs: options.maximumDurationMs,
      pattern: options.pattern,
      startAfterMs: options.startAfterMs,
    },
    triggerResult: maximum,
  }
}
