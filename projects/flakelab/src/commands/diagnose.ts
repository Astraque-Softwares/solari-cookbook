import { resolve } from "node:path"

import { createNdjsonWriter } from "../artifacts/ndjson.js"
import { runRequestSchema } from "../domain/schema.js"
import { runLocalDiagnostics } from "../runner/local.js"
import { createPlaywrightExecutor } from "../runner/playwright-executor.js"
import type { CliValues } from "./options.js"
import { integerOption, withInterruption } from "./options.js"

export async function diagnose(selector: string, values: CliValues): Promise<void> {
  const projectRoot = process.cwd()
  const request = runRequestSchema.parse({
    selector,
    runs: integerOption(values.runs, "runs"),
    seed: integerOption(values.seed, "seed"),
    artifactDirectory: resolve(projectRoot, values.artifacts),
    fault: {
      kind: "network-delay",
      pattern: values.pattern,
      delayMs: integerOption(values["delay-ms"], "delay-ms"),
    },
  })
  const artifactPath = resolve(request.artifactDirectory, `run-${Date.now()}`, "events.ndjson")
  const result = await withInterruption(async (signal) => runLocalDiagnostics(
    request,
    createPlaywrightExecutor(projectRoot, selector, { signal }),
    createNdjsonWriter(artifactPath),
    { concurrency: integerOption(values.concurrency, "concurrency"), signal },
  ))
  console.log(JSON.stringify({ ...result, artifactPath }, null, 2))
  if (result.summary.errors > 0) {
    process.exitCode = 1
  }
}
