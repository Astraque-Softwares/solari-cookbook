import type { RunRequest, TrialPlan } from "../domain/schema.js"

const UINT32_RANGE = 0x1_0000_0000
const GOLDEN_RATIO_32 = 2_654_435_761

export function deriveTrialSeed(seed: number, index: number): number {
  return (seed + index * GOLDEN_RATIO_32) % UINT32_RANGE
}

export function planTrials(request: RunRequest): TrialPlan[] {
  return Array.from({ length: request.runs }, (_, index) => {
    const seed = deriveTrialSeed(request.seed, index)
    return {
      trialId: `trial-${String(index + 1).padStart(3, "0")}-${seed}`,
      index,
      seed,
      fault: index % 2 === 1 ? request.fault : undefined,
    }
  })
}
