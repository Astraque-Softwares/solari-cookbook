import type { ExperimentResult } from "../discovery/evaluate.js"
import type { Fault } from "../domain/schema.js"
import type { Reproducer } from "../reproducer/schema.js"

export function buildDiscoveredReproducer(
  test: string,
  seed: number,
  minimumRate: number,
  trigger: Fault,
  triggerResult: ExperimentResult,
): Reproducer {
  return {
    test,
    seed,
    trials: triggerResult.trials,
    faults: [trigger],
    expectedFailure: {
      minimumRate,
      ...(triggerResult.dominantFailureSignature
        ? { signature: triggerResult.dominantFailureSignature }
        : {}),
    },
  }
}
