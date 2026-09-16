import { parseArgs } from "node:util"
import { resolve } from "node:path"

import { evaluateExperiment } from "../discovery/evaluate.js"
import { faultSetSchema } from "../domain/schema.js"
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
      config: { type: "string" },
      "faults-json": { type: "string" },
      hostile: { type: "boolean", default: false },
      "min-rate": { type: "string" },
      seed: { type: "string" },
      selector: { type: "string" },
      trials: { type: "string" },
    },
  })
  const faults = values.hostile
    ? faultSetSchema.parse(JSON.parse(required(values["faults-json"], "faults-json")))
    : []
  const result = await evaluateExperiment(
    createPlaywrightExecutor(process.cwd(), required(values.selector, "selector"), {
      ...(values.config ? { configPath: resolve(process.cwd(), values.config) } : {}),
    }),
    {
      concurrency: integer(values.concurrency, "concurrency"),
      faults,
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
