import type { ExperimentResult } from "../discovery/evaluate.js"

export function hasConfirmedCausalSignal(
  result: ExperimentResult,
  baselineUpperBound: number,
): boolean {
  if (!result.confirmed) return false
  const effect = result.causalEffect
  if (effect) {
    return effect.failureRateIncrease > 0
      && effect.treatmentLowerBound80 > effect.controlUpperBound80
  }
  return result.lowerBound80 > baselineUpperBound
}
