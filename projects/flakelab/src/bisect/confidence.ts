const WILSON_Z_80 = 1.281_551_565_545

export interface ConfidenceInterval {
  lower: number
  upper: number
}

export function wilsonInterval80(failures: number, trials: number): ConfidenceInterval {
  if (trials === 0) {
    return { lower: 0, upper: 1 }
  }
  const probability = failures / trials
  const squaredZ = WILSON_Z_80 ** 2
  const denominator = 1 + squaredZ / trials
  const center = probability + squaredZ / (2 * trials)
  const margin = WILSON_Z_80 * Math.sqrt(
    (probability * (1 - probability) + squaredZ / (4 * trials)) / trials,
  )
  return {
    lower: Math.max(0, (center - margin) / denominator),
    upper: Math.min(1, (center + margin) / denominator),
  }
}

export type ConfidenceClassification = "bad" | "good" | "inconclusive"

export function classifyFailureProbability(
  failures: number,
  trials: number,
  errors: number,
  minimumFailureRate: number,
): ConfidenceClassification {
  const validTrials = trials - errors
  if (validTrials <= 0 || failures > validTrials) {
    return "inconclusive"
  }
  const interval = wilsonInterval80(failures, validTrials)
  if (interval.lower >= minimumFailureRate) {
    return "bad"
  }
  return interval.upper < minimumFailureRate ? "good" : "inconclusive"
}
