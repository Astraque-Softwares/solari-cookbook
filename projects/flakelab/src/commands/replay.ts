import { resolve } from "node:path"

import { evaluateExperiment } from "../discovery/evaluate.js"
import { readReproducer } from "../reproducer/file.js"
import { createPlaywrightExecutor } from "../runner/playwright-executor.js"
import type { CliValues } from "./options.js"
import { integerOption, withInterruption } from "./options.js"

export async function replay(filePath: string, values: CliValues): Promise<void> {
  const projectRoot = process.cwd()
  const reproducer = await readReproducer(resolve(projectRoot, filePath))
  const fault = reproducer.faults[0]
  const result = await withInterruption(async (signal) => evaluateExperiment(
    createPlaywrightExecutor(projectRoot, reproducer.test, { signal }),
    {
      concurrency: integerOption(values.concurrency, "concurrency"),
      fault,
      minimumFailureRate: reproducer.expectedFailure.minimumRate,
      seed: reproducer.seed,
      signal,
      trials: reproducer.trials,
    },
  ))
  const signatureMatches = !reproducer.expectedFailure.signature
    || reproducer.expectedFailure.signature === result.dominantFailureSignature
  const reproduced = result.confirmed && signatureMatches
  console.log(JSON.stringify({ reproduced, signatureMatches, result }, null, 2))
  if (!reproduced) {
    process.exitCode = 1
  }
}
