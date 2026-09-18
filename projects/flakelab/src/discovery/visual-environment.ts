import type {
  AnimationSpeedFault,
  Fault,
  ReducedMotionFault,
  ViewportFault,
} from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import type { ExperimentResult } from "./evaluate.js"
import { createCausalEvaluator } from "./evaluate.js"

interface VisualDiscoveryOptions {
  concurrency: number
  minimumFailureRate: number
  pattern: string
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface AnimationSpeedDiscoveryOptions extends VisualDiscoveryOptions {
  rate: number
}

export interface ViewportDiscoveryOptions extends VisualDiscoveryOptions {
  height: number
  width: number
}

export interface VisualDiscoveryResult<T extends Fault> {
  baseline: ExperimentResult
  experiments: ExperimentResult[]
  trigger: T
  triggerResult: ExperimentResult
}

async function confirmVisualFault<T extends AnimationSpeedFault | ReducedMotionFault | ViewportFault>(
  execute: TrialExecutor,
  options: VisualDiscoveryOptions,
  trigger: T,
  label: string,
): Promise<VisualDiscoveryResult<T>> {
  const common = {
    concurrency: options.concurrency,
    minimumFailureRate: options.minimumFailureRate,
    seed: options.seed,
    signal: options.signal,
  }
  const evaluator = createCausalEvaluator(execute, { ...common, trials: options.trials })
  const triggerResult = await evaluator.evaluate([trigger])
  if (!triggerResult.confirmed) {
    throw new Error(`${label} did not reproduce the failure confidently`)
  }
  return { baseline: evaluator.baseline(), experiments: [triggerResult], trigger, triggerResult }
}

export function discoverAnimationSpeed(
  execute: TrialExecutor,
  options: AnimationSpeedDiscoveryOptions,
): Promise<VisualDiscoveryResult<AnimationSpeedFault>> {
  return confirmVisualFault(execute, options, {
    kind: "animation-speed",
    pattern: options.pattern,
    rate: options.rate,
  }, "Animation speed")
}

export function discoverReducedMotion(
  execute: TrialExecutor,
  options: VisualDiscoveryOptions,
): Promise<VisualDiscoveryResult<ReducedMotionFault>> {
  return confirmVisualFault(execute, options, {
    kind: "reduced-motion",
    pattern: options.pattern,
  }, "Reduced motion")
}

export function discoverViewport(
  execute: TrialExecutor,
  options: ViewportDiscoveryOptions,
): Promise<VisualDiscoveryResult<ViewportFault>> {
  return confirmVisualFault(execute, options, {
    height: options.height,
    kind: "viewport",
    pattern: options.pattern,
    width: options.width,
  }, "Viewport change")
}
