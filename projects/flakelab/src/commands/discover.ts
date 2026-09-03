import { writeFile } from "node:fs/promises"
import { basename, dirname, extname, resolve } from "node:path"

import { discoverNetworkDelay } from "../discovery/minimize.js"
import { writeReproducer } from "../reproducer/file.js"
import { createPlaywrightExecutor } from "../runner/playwright-executor.js"
import type { CliValues } from "./options.js"
import { integerOption, rateOption, withInterruption } from "./options.js"

export async function discover(selector: string, values: CliValues): Promise<void> {
  const projectRoot = process.cwd()
  const outputPath = resolve(projectRoot, values.output)
  const seed = integerOption(values.seed, "seed")
  const trials = integerOption(values.trials, "trials")
  const minimumFailureRate = rateOption(values["min-rate"])
  const result = await withInterruption(async (signal) => discoverNetworkDelay(
    createPlaywrightExecutor(projectRoot, selector, { signal }),
    {
      concurrency: integerOption(values.concurrency, "concurrency"),
      maximumDelayMs: integerOption(values["max-delay"], "max-delay"),
      minimumFailureRate,
      pattern: values.pattern,
      seed,
      signal,
      trials,
    },
  ))
  await writeReproducer(outputPath, {
    version: 1,
    test: selector,
    seed,
    trials,
    faults: [result.trigger],
    expectedFailure: {
      minimumRate: minimumFailureRate,
      ...(result.triggerResult.dominantFailureSignature
        ? { signature: result.triggerResult.dominantFailureSignature }
        : {}),
    },
  })
  const discoveryPath = resolve(
    dirname(outputPath),
    `${basename(outputPath, extname(outputPath))}.discovery.json`,
  )
  await writeFile(discoveryPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8" })
  console.log(JSON.stringify({
    baseline: result.baseline,
    experiments: result.experiments.length,
    reproducerPath: outputPath,
    discoveryPath,
    trigger: result.trigger,
    triggerResult: result.triggerResult,
  }, null, 2))
}
