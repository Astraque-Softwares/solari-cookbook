
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type { Fault, TrialOutcome, TrialPlan } from "../domain/schema.js"
import { trialFaultSetSchema } from "../domain/schema.js"
import { portableProjectPath } from "../artifacts/paths.js"
import { startFaultProxy } from "./fault-proxy.js"
import type { FaultProxy } from "./fault-proxy.js"
import type { ObservedRequest } from "./request-observation.js"
import { createTemporaryProjectBridge } from "./project-bridge.js"
import { isRunnerExecutionFault, runnerExecutionControls } from "./execution-fault.js"
import type { CapturedProcessResult } from "./process-tree.js"
import { waitForProcessTree } from "./process-tree.js"

const bundledPlaywrightCliPath = fileURLToPath(import.meta.resolve("@playwright/test/cli"))
const trialReporterPath = fileURLToPath(new URL(
  import.meta.url.endsWith(".ts") ? "./trial-reporter.ts" : "./trial-reporter.js",
  import.meta.url,
))
const PRIVATE_FLAKELAB_ENVIRONMENT = new Set([
  "GROQ_API_KEY",
  "SOLARI_API_KEY",
])
const trialReporterOutputSchema = z.object({
  artifacts: z.array(z.object({
    contentType: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
  })).max(5),
  failures: z.array(z.string().min(1).max(2_000)).max(10),
  status: z.enum(["passed", "failed", "timedout", "interrupted"]),
})

export type TrialExecutor = (trial: TrialPlan) => Promise<TrialOutcome>

interface ExecutorOptions {
  artifactRoot?: string
  captureTrace?: boolean
  configPath?: string
  environment?: NodeJS.ProcessEnv
  onObservedRequests?: (requests: ObservedRequest[]) => void
  playwrightCliPath?: string
  signal?: AbortSignal
}

export function resolvePlaywrightCliPath(projectRoot: string): string {
  const projectRequire = createRequire(join(projectRoot, "package.json"))
  try {
    return projectRequire.resolve("@playwright/test/cli")
  } catch {
    return bundledPlaywrightCliPath
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

async function optionalFaultProxy(
  faults: readonly Fault[],
  observer: ExecutorOptions["onObservedRequests"],
): Promise<FaultProxy | undefined> {
  if (faults.length === 0 && !observer) return undefined
  return startFaultProxy(faults)
}

function captureObservedRequests(
  proxy: FaultProxy | undefined,
  observer: ExecutorOptions["onObservedRequests"],
): void {
  if (!proxy || !observer) return
  observer(proxy.observedRequests())
}

export function trialOutputDirectory(
  projectRoot: string,
  runId: string,
  trial: TrialPlan,
): string {
  const runSegment = fingerprint(runId)
  const trialSegment = fingerprint(`${trial.index}:${trial.trialId}`)
  return join(projectRoot, ".flakelab", "test-results", runSegment, trialSegment)
}

export function createTrialEnvironment(
  trial: TrialPlan,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = createPlaywrightEnvironment(parentEnvironment)
  return {
    ...environment,
    FLAKELAB_TRIAL_SEED: String(trial.seed),
  }
}

export function createPlaywrightEnvironment(
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(parentEnvironment).filter(([name]) => !PRIVATE_FLAKELAB_ENVIRONMENT.has(name)),
  )
  return environment
}

function stripAnsi(value: string): string {
  let result = ""
  let escapeState = 0
  for (const character of value) {
    if (escapeState === 0 && character === String.fromCharCode(27)) {
      escapeState = 1
    } else if (escapeState === 1) {
      escapeState = character === "[" ? 2 : 0
    } else if (escapeState === 2) {
      const code = character.codePointAt(0) ?? 0
      escapeState = code >= 0x40 && code <= 0x7e ? 0 : 2
    } else {
      result += character
    }
  }
  return result
}

export function normalizeFailureOutput(value: string): string {
  const withoutAnsi = stripAnsi(value)
  const lines = withoutAnsi
    .split(/\r?\n/u)
    .map((line) => line.trim())
  const isTestLine = (line: string): boolean =>
    line.includes("›") && /\.(?:spec|test)\.[cm]?[jt]sx?:\d+/u.test(line)
  const failedTestLine = lines.find((line) => /^\d+\)\s/u.test(line) && isTestLine(line))
  const testLine = failedTestLine ?? lines.slice().reverse().find(isTestLine)
  const prefixes = ["Error: ", "Locator:", "Expected:", "Received:"]
  const diagnosticLines = prefixes
    .map((prefix) => lines.find((line) => line.startsWith(prefix)))
    .filter((line) => line !== undefined)
  const normalizedTestLine = testLine?.replace(/^\d+\)\s+/u, "")
  const selected = normalizedTestLine
    ? [normalizedTestLine, ...diagnosticLines]
    : diagnosticLines
  if (selected.length === 0) {
    const fallback = lines
      .filter((line) => /error|failed|not found|cannot|enoent|timed out|webserver|exit code/iu.test(line))
      .slice(-6)
    return fallback.length > 0 ? fallback.join("\n") : "playwright-exit-failure"
  }
  return selected
    .join("\n")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gu, "<duration>")
    .replace(/:\d+:\d+\b/gu, ":<line>")
}

async function reporterOutput(path: string): Promise<z.infer<typeof trialReporterOutputSchema> | undefined> {
  try {
    return trialReporterOutputSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch {
    return undefined
  }
}

function failedOutcome(
  reason: string,
  durationMs: number,
  exitCode: number | null,
  status: TrialOutcome["status"],
  artifacts: TrialOutcome["artifacts"] = [],
): TrialOutcome {
  const failureReason = normalizeFailureOutput(reason)
  return {
    artifacts,
    status,
    durationMs,
    exitCode,
    failureSignature: fingerprint(failureReason),
    failureReason,
  }
}

async function classifyTrialExecution(
  trial: TrialPlan,
  execution: CapturedProcessResult,
  reportPath: string,
  durationMs: number,
  signalAborted: boolean,
  unmatchedFaults: Fault[],
  projectRoot: string,
): Promise<TrialOutcome> {
  const report = await reporterOutput(reportPath)
  const artifacts = (report?.artifacts ?? []).flatMap((artifact) => {
    const path = portableProjectPath(projectRoot, artifact.path)
    return path.startsWith("<outside-project>/") ? [] : [{ ...artifact, path }]
  })
  if (signalAborted) {
    return failedOutcome(
      "Error: diagnostic aborted",
      durationMs,
      execution.exitCode,
      "error",
      artifacts,
    )
  }
  if (execution.spawnError) {
    return failedOutcome(execution.spawnError, durationMs, null, "error", artifacts)
  }
  if (unmatchedFaults.length > 0) {
    const descriptions = unmatchedFaults.map((fault) => `${fault.kind} (${fault.pattern})`)
    return failedOutcome(
      `Error: project-level faults were not applied: ${descriptions.join(", ")}; HTTPS path injection is not supported yet`,
      durationMs,
      execution.exitCode,
      "error",
      artifacts,
    )
  }
  if (execution.exitCode === 0) {
    return { artifacts, status: "passed", durationMs, exitCode: 0 }
  }
  const diagnostic = report?.failures[0] ?? execution.diagnostic
  return failedOutcome(diagnostic, durationMs, execution.exitCode, "failed", artifacts)
}

async function cleanupTrialResources(
  bridge: Awaited<ReturnType<typeof createTemporaryProjectBridge>>,
  reportPath: string,
  proxy: Awaited<ReturnType<typeof startFaultProxy>> | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    bridge.remove(),
    rm(reportPath, { force: true }),
    proxy?.close() ?? Promise.resolve(),
  ])
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("FlakeLab could not completely clean up the trial")
  }
}

export function createPlaywrightExecutor(
  projectRoot: string,
  selector: string,
  options: ExecutorOptions = {},
): TrialExecutor {
  const playwrightCliPath = options.playwrightCliPath ?? resolvePlaywrightCliPath(projectRoot)
  const artifactRoot = options.artifactRoot ?? projectRoot
  const runId = randomUUID()
  return async (trial) => {
    const startedAt = Date.now()
    if (options.signal?.aborted) {
      return {
        artifacts: [],
        status: "error",
        durationMs: 0,
        exitCode: null,
        failureSignature: fingerprint("diagnostic aborted"),
      }
    }
    const outputDirectory = trialOutputDirectory(artifactRoot, runId, trial)
    await mkdir(outputDirectory, { recursive: true })
    // Playwright empties its output directory when a run starts, so reporter
    // coordination must live beside that directory rather than inside it.
    const reportPath = `${outputDirectory}.report.json`
    const faults = trialFaultSetSchema.parse(trial.faults)
    const browserFaults = faults.filter((fault) => !isRunnerExecutionFault(fault))
    const executionControls = runnerExecutionControls(faults)
    const bridge = await createTemporaryProjectBridge(
      projectRoot,
      trialReporterPath,
      browserFaults,
      options.captureTrace === true,
      options.configPath,
    )
    let proxy: Awaited<ReturnType<typeof startFaultProxy>> | undefined
    try {
      proxy = await optionalFaultProxy(browserFaults, options.onObservedRequests)
      const environment = {
        ...createTrialEnvironment(trial, { ...process.env, ...options.environment }),
        ...executionControls.environment,
        FLAKELAB_TRIAL_REPORT_PATH: reportPath,
        ...(proxy ? { FLAKELAB_PROXY_URL: proxy.url } : {}),
      }
      const child = spawn(
        process.execPath,
        [
          playwrightCliPath,
          "test",
          selector,
          "--config",
          bridge.configPath,
          "--output",
          outputDirectory,
          ...executionControls.arguments,
        ],
        {
          cwd: projectRoot,
          detached: process.platform !== "win32",
          shell: false,
          env: environment,
          windowsHide: true,
        },
      )
      const execution = await waitForProcessTree(child, options.signal)
      const durationMs = Date.now() - startedAt
      return classifyTrialExecution(
        trial,
        execution,
        reportPath,
        durationMs,
        options.signal?.aborted === true,
        proxy?.unmatchedFaults() ?? [],
        artifactRoot,
      )
    } finally {
      try {
        captureObservedRequests(proxy, options.onObservedRequests)
      } finally {
        await cleanupTrialResources(bridge, reportPath, proxy)
      }
    }
  }
}
