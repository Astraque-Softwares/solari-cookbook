import { parseArgs } from "node:util"

import { evaluateExperiment } from "../discovery/evaluate.js"
import type { Fault } from "../domain/schema.js"
import { createPlaywrightExecutor } from "../runner/playwright-executor.js"

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function integer(value: string | undefined, name: string): number {
  const parsed = Number(required(value, name))
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`)
  }
  return parsed
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      concurrency: { type: "string" },
      "delay-ms": { type: "string" },
      hostile: { type: "boolean", default: false },
      "min-rate": { type: "string" },
      pattern: { type: "string" },
      seed: { type: "string" },
      selector: { type: "string" },
      trials: { type: "string" },
    },
  })
  const fault: Fault | undefined = values.hostile
    ? {
        kind: "network-delay",
        delayMs: integer(values["delay-ms"], "delay-ms"),
        pattern: required(values.pattern, "pattern"),
      }
    : undefined
  const result = await evaluateExperiment(
    createPlaywrightExecutor(process.cwd(), required(values.selector, "selector")),
    {
      concurrency: integer(values.concurrency, "concurrency"),
      fault,
      minimumFailureRate: Number(required(values["min-rate"], "min-rate")),
      seed: integer(values.seed, "seed"),
      trials: integer(values.trials, "trials"),
    },
  )
  console.log(JSON.stringify(result))
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : "Remote proof runner failed")
  process.exitCode = 1
}
