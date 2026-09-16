export interface ScanOptions {
  artifacts: string
  concurrency: string
  config?: string
  json: boolean
  runs: string
  verbose: boolean
}

export interface AnalyzeOptions {
  artifacts: string
  baseline?: string
  json: boolean
  verbose: boolean
}

export interface DiagnoseOptions {
  artifacts: string
  baseline?: string
  concurrency: string
  config?: string
  discover: boolean
  evidence: string
  html: string
  investigate: boolean
  "max-cost": string
  "max-delay": string
  "max-experiments": string
  "max-seconds": string
  "max-steps": string
  "max-trials": string
  "min-rate": string
  model: string
  open: boolean
  patch: string
  pattern: string
  proof: string
  "prompt-credentials": boolean
  repair: boolean
  report?: string
  reproducer: string
  runs: string
  seed: string
  source: string[]
  trials: string
}

export interface DiscoverOptions {
  "animation-rate": string
  "clock-offset-ms": string
  concurrency: string
  config?: string
  "cookie-name"?: string
  fault: string
  "jump-after-ms": string
  locale: string
  "max-delay": string
  "max-copies": string
  "max-duplicate-bytes": string
  "max-hold-ms": string
  "max-remove-bytes": string
  "max-seconds": string
  "max-stall-ms": string
  "max-workers": string
  "min-rate": string
  output: string
  pattern: string
  "resource-type": string
  "startup-event": string
  "stall-after-ms": string
  seed: string
  storage: string
  "storage-key"?: string
  timezone: string
  trials: string
  "viewport-height": string
  "viewport-width": string
}

export interface ReplayOptions {
  concurrency: string
}

export interface InvestigateOptions {
  concurrency: string
  config?: string
  "max-cost": string
  "max-delay": string
  "max-experiments": string
  "max-seconds": string
  "max-steps": string
  "max-trials": string
  "min-rate": string
  model: string
  pattern: string
  "prompt-credentials": boolean
  report: string
  seed: string
  trials: string
}

export interface RepairOptions {
  concurrency: string
  "max-cost": string
  "max-seconds": string
  model: string
  patch: string
  proof: string
  "prompt-credentials": boolean
  reproducer: string
  source: string[]
}

export interface ReportOptions {
  html: string
  open: boolean
  patch: string
  proof: string
  "prompt-credentials": boolean
  publish: boolean
  reproducer: string
}

export interface BisectOptions {
  bad: string
  "bisect-parallelism": string
  "bisect-report": string
  concurrency: string
  good: string
  "max-trials": string
  "min-rate": string
  "prompt-credentials": boolean
  reproducer: string
}

export interface ProveOptions extends DiscoverOptions {
  html: string
  "max-cost": string
  "max-experiments": string
  "max-steps": string
  "max-trials": string
  model: string
  open: boolean
  patch: string
  proof: string
  "prompt-credentials": boolean
  publish: boolean
  report: string
  reproducer: string
  source: string[]
}

export function positiveNumberOption(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be greater than zero`)
  }
  return parsed
}

export function integerOption(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`)
  }
  return parsed
}

export function rateOption(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error("min-rate must be greater than 0 and at most 1")
  }
  return parsed
}

export async function withInterruption<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { maxSeconds?: number; timeoutMessage?: string } = {},
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const abort = (): void => {
    controller.abort()
  }
  const timeout = options.maxSeconds === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true
      abort()
    }, options.maxSeconds * 1_000)
  process.once("SIGINT", abort)
  try {
    const result = await operation(controller.signal)
    if (timedOut) {
      throw new Error(options.timeoutMessage ?? "Operation exceeded its time limit")
    }
    return result
  } catch (error) {
    if (timedOut) {
      throw new Error(options.timeoutMessage ?? "Operation exceeded its time limit", {
        cause: error,
      })
    }
    throw error
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
    process.removeListener("SIGINT", abort)
  }
}
