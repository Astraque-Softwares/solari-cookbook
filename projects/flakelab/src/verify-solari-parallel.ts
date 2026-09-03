import { config as loadEnv } from "dotenv"

import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { runSolariDemo } from "./solari/run-demo.js"
import { withSolariTransport } from "./solari/transport.js"

loadEnv({ path: resolve(import.meta.dirname, "../.env"), quiet: true })

function requireApiKey(): string {
  const apiKey = process.env.SOLARI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("SOLARI_API_KEY is required for the live Solari parallel verification")
  }
  return apiKey
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

async function main(): Promise<void> {
  const projectRoot = resolve(import.meta.dirname, "..")
  const { values } = parseArgs({
    options: {
      concurrency: { type: "string", default: "8" },
      runs: { type: "string", default: "8" },
    },
  })
  const abortController = new AbortController()
  const abort = (): void => {
    abortController.abort()
  }
  process.once("SIGINT", abort)
  try {
    const result = await withSolariTransport(async () => runSolariDemo({
      apiKey: requireApiKey(),
      baseUrl: process.env.SOLARI_BASE_URL?.trim() ?? "https://api.getsolari.com",
      artifactDirectory: resolve(projectRoot, ".flakelab/runs"),
      concurrency: positiveInteger(values.concurrency, "concurrency"),
      delayMs: 250,
      projectRoot,
      runs: positiveInteger(values.runs, "runs"),
      seed: 42,
      signal: abortController.signal,
    }))
    console.log(JSON.stringify(result, null, 2))
    if (result.summary.errors > 0) {
      process.exitCode = 1
    }
  } finally {
    process.removeListener("SIGINT", abort)
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : "Parallel Solari verification failed")
  process.exitCode = 1
}
