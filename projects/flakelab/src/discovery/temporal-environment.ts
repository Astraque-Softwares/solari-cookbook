import type { ClockJumpFault, Fault, LocaleFault, TimezoneFault } from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import type { ExperimentResult } from "./evaluate.js"
import { createCausalEvaluator } from "./evaluate.js"

interface TemporalDiscoveryOptions {
  concurrency: number
  minimumFailureRate: number
  pattern: string
  seed: number
  signal?: AbortSignal
  trials: number
}

export interface ClockJumpDiscoveryOptions extends TemporalDiscoveryOptions {
  jumpAfterMs: number
  offsetMs: number
}

export interface LocaleDiscoveryOptions extends TemporalDiscoveryOptions {
  locale: string
}

export interface TimezoneDiscoveryOptions extends TemporalDiscoveryOptions {
  timezoneId: string
}

export interface TemporalDiscoveryResult<T extends Fault> {
  baseline: ExperimentResult
  experiments: ExperimentResult[]
  trigger: T
  triggerResult: ExperimentResult
}

async function confirmTemporalFault<T extends ClockJumpFault | LocaleFault | TimezoneFault>(
  execute: TrialExecutor,
  options: TemporalDiscoveryOptions,
  trigger: T,
  label: string,
): Promise<TemporalDiscoveryResult<T>> {
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

export function discoverClockJump(
  execute: TrialExecutor,
  options: ClockJumpDiscoveryOptions,
): Promise<TemporalDiscoveryResult<ClockJumpFault>> {
  return confirmTemporalFault(execute, options, {
    kind: "clock-jump",
    jumpAfterMs: options.jumpAfterMs,
    offsetMs: options.offsetMs,
    pattern: options.pattern,
  }, "Clock jump")
}

export function discoverLocale(
  execute: TrialExecutor,
  options: LocaleDiscoveryOptions,
): Promise<TemporalDiscoveryResult<LocaleFault>> {
  return confirmTemporalFault(execute, options, {
    kind: "locale",
    locale: options.locale,
    pattern: options.pattern,
  }, "Locale change")
}

export function discoverTimezone(
  execute: TrialExecutor,
  options: TimezoneDiscoveryOptions,
): Promise<TemporalDiscoveryResult<TimezoneFault>> {
  return confirmTemporalFault(execute, options, {
    kind: "timezone",
    pattern: options.pattern,
    timezoneId: options.timezoneId,
  }, "Timezone change")
}
