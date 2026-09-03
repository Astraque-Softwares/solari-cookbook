export interface CliValues {
  artifacts: string
  bad: string
  "bisect-parallelism": string
  "bisect-report": string
  concurrency: string
  "delay-ms": string
  "max-cost": string
  "max-delay": string
  "max-experiments": string
  "max-seconds": string
  "max-steps": string
  "max-trials": string
  "min-rate": string
  html: string
  good: string
  help: boolean
  model: string
  open: boolean
  output: string
  patch: string
  publish: boolean
  proof: string
  prove: boolean
  report: string
  reproducer: string
  pattern: string
  runs: string
  seed: string
  trials: string
  verbose: boolean
  version: boolean
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
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort()
  }
  process.once("SIGINT", abort)
  try {
    return await operation(controller.signal)
  } finally {
    process.removeListener("SIGINT", abort)
  }
}
