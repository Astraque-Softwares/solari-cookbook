import type {
  SharedStateInterferenceFault,
  WorkerPressureFault,
} from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import type { ExperimentResult } from "./evaluate.js"
import { createCausalEvaluator } from "./evaluate.js"

interface RunnerDiscoveryOptions {
  concurrency: number
  minimumFailureRate: number
  pattern: string
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface WorkerPressureDiscoveryOptions extends RunnerDiscoveryOptions {
  maximumWorkers: number
}

export interface SharedStateDiscoveryOptions extends RunnerDiscoveryOptions {
  maximumCopies: number
}

export interface RunnerDiscoveryResult<T extends WorkerPressureFault | SharedStateInterferenceFault> {
  baseline: ExperimentResult
  experiments: ExperimentResult[]
  trigger: T
  triggerResult: ExperimentResult
}

interface RunnerSearchOptions<T extends WorkerPressureFault | SharedStateInterferenceFault> {
  buildFault: (value: number) => T
  execute: TrialExecutor
  label: string
  maximum: number
  options: RunnerDiscoveryOptions
}

function validateMaximum(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 2 || value > 16) {
    throw new Error(`${label} must be an integer between 2 and 16`)
  }
}

async function discoverRobustMaximum<T extends WorkerPressureFault | SharedStateInterferenceFault>(
  search: RunnerSearchOptions<T>,
): Promise<RunnerDiscoveryResult<T>> {
  const common = {
    concurrency: search.options.concurrency,
    minimumFailureRate: search.options.minimumFailureRate,
    seed: search.options.seed,
    signal: search.options.signal,
  }
  const evaluator = createCausalEvaluator(search.execute, {
    ...common,
    trials: search.options.trials,
  })
  const experiments: ExperimentResult[] = []
  const trigger = search.buildFault(search.maximum)
  const triggerResult = await evaluator.evaluate([trigger])
  experiments.push(triggerResult)
  if (!triggerResult.confirmed) {
    throw new Error(`${search.label} did not reproduce the failure confidently`)
  }
  return { baseline: evaluator.baseline(), experiments, trigger, triggerResult }
}

export function discoverWorkerPressure(
  execute: TrialExecutor,
  options: WorkerPressureDiscoveryOptions,
): Promise<RunnerDiscoveryResult<WorkerPressureFault>> {
  validateMaximum(options.maximumWorkers, "max-workers")
  return discoverRobustMaximum({
    buildFault: (workers) => ({
      kind: "worker-pressure",
      pattern: options.pattern,
      workers,
    }),
    execute,
    label: "Worker pressure",
    maximum: options.maximumWorkers,
    options,
  })
}

export function discoverSharedStateInterference(
  execute: TrialExecutor,
  options: SharedStateDiscoveryOptions,
): Promise<RunnerDiscoveryResult<SharedStateInterferenceFault>> {
  validateMaximum(options.maximumCopies, "max-copies")
  return discoverRobustMaximum({
    buildFault: (copies) => ({
      copies,
      kind: "shared-state-interference",
      pattern: options.pattern,
    }),
    execute,
    label: "Shared-state interference",
    maximum: options.maximumCopies,
    options,
  })
}
