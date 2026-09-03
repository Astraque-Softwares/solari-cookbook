import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { createNdjsonWriter } from "../artifacts/ndjson.js"
import { runRequestSchema } from "../domain/schema.js"
import type { DiagnosticResult } from "../runner/local.js"
import { runLocalDiagnostics } from "../runner/local.js"
import { checkoutServerSource } from "./checkout-fixture.js"
import { SolariParallelExecutor } from "./executor.js"
import type { ResourceUsage } from "./usage.js"

export interface SolariDemoOptions {
  apiKey: string
  artifactDirectory: string
  baseUrl: string
  concurrency: number
  delayMs: number
  projectRoot: string
  runs: number
  seed: number
  signal?: AbortSignal
}

const execFileAsync = promisify(execFile)

export function snapshotCacheKey(commit: string, lockfile: string, fixture: string): string {
  return createHash("sha256")
    .update(commit)
    .update("\0")
    .update(lockfile)
    .update("\0")
    .update(fixture)
    .digest("hex")
    .slice(0, 24)
}

async function snapshotName(projectRoot: string): Promise<string> {
  const [{ stdout: commit }, lockfile] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }),
    readFile(resolve(projectRoot, "pnpm-lock.yaml"), "utf8"),
  ])
  return `flakelab-${snapshotCacheKey(commit.trim(), lockfile, checkoutServerSource)}`
}

export interface SolariDemoResult extends DiagnosticResult {
  artifactPath: string
  metricsPath: string
  snapshotId: string
  usage: ResourceUsage
}

export async function runSolariDemo(options: SolariDemoOptions): Promise<SolariDemoResult> {
  const runDirectory = resolve(options.artifactDirectory, `solari-${Date.now()}`)
  const artifactPath = resolve(runDirectory, "events.ndjson")
  const metricsPath = resolve(runDirectory, "metrics.json")
  const request = runRequestSchema.parse({
    selector: "solari-checkout-demo",
    runs: options.runs,
    seed: options.seed,
    artifactDirectory: runDirectory,
    fault: {
      kind: "network-delay",
      pattern: "**/api/checkout",
      delayMs: options.delayMs,
    },
  })
  const executor = new SolariParallelExecutor({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    signal: options.signal,
    snapshotName: await snapshotName(options.projectRoot),
  })
  let result: DiagnosticResult
  let snapshotId: string
  try {
    await executor.prepare()
    snapshotId = executor.snapshotId()
    result = await runLocalDiagnostics(
      request,
      executor.execute,
      createNdjsonWriter(artifactPath),
      { concurrency: options.concurrency, signal: options.signal },
    )
  } finally {
    await executor.close()
  }
  const usage = executor.usage()
  await writeFile(metricsPath, `${JSON.stringify(usage, null, 2)}\n`, { encoding: "utf8" })
  return { ...result, artifactPath, metricsPath, snapshotId, usage }
}
