export interface DiscoveryBudget {
  configuredSeconds: number
  estimatedSeconds: number
  recommendedSeconds: number
}

interface DiscoveryBudgetInput {
  concurrency: number
  configuredSeconds: number
  elapsedMilliseconds: number
  observedRuns: number
  plannedTrials: number
}

export function buildDiscoveryBudget(input: DiscoveryBudgetInput): DiscoveryBudget {
  const estimatedSeconds = Math.ceil(
    input.elapsedMilliseconds * input.plannedTrials
      / input.observedRuns / input.concurrency / 1_000 / 60,
  ) * 60
  const recommendedSeconds = Math.max(60, Math.ceil(estimatedSeconds * 2 / 60) * 60)
  return {
    configuredSeconds: input.configuredSeconds,
    estimatedSeconds,
    recommendedSeconds,
  }
}
