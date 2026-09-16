import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

import { z } from "zod"

import { portableScanTestPaths } from "../artifacts/paths.js"
import { retainOwnedArtifacts } from "../artifacts/retention.js"
import { redactText } from "../report/redaction.js"
import {
  type FailureClusterMap,
  type FailureObservation,
  finalizeFailureClusters,
  recordFailureObservation,
} from "../scan/failure-clusters.js"
import type { ScanCounts, ScanTestResult, ScanTestStatus } from "../scan/schema.js"
import {
  createPlaywrightEnvironment,
  normalizeFailureOutput,
  resolvePlaywrightCliPath,
} from "./playwright-executor.js"
import { type CapturedProcessResult, waitForProcessTree } from "./process-tree.js"

const WILSON_Z_80 = 1.281_551_565_545

const playwrightErrorSchema = z.object({
  message: z.string().optional(),
})

const playwrightAttachmentSchema = z.object({
  contentType: z.string(),
  name: z.string(),
  path: z.string().optional(),
})

const playwrightResultSchema = z.object({
  attachments: z.array(playwrightAttachmentSchema).optional(),
  duration: z.number().nonnegative(),
  errors: z.array(playwrightErrorSchema).optional(),
  status: z.enum(["failed", "interrupted", "passed", "skipped", "timedOut"]),
})

const playwrightTestSchema = z.object({
  projectName: z.string(),
  results: z.array(playwrightResultSchema),
  status: z.enum(["expected", "flaky", "skipped", "unexpected"]),
})

const playwrightSpecSchema = z.object({
  column: z.number().int().positive(),
  file: z.string().min(1),
  line: z.number().int().positive(),
  tests: z.array(playwrightTestSchema),
  title: z.string().min(1),
})

interface PlaywrightSuite {
  specs?: z.infer<typeof playwrightSpecSchema>[]
  suites?: PlaywrightSuite[]
  title: string
}

const playwrightSuiteSchema: z.ZodType<PlaywrightSuite> = z.lazy(() => z.object({
  specs: z.array(playwrightSpecSchema).optional(),
  suites: z.array(playwrightSuiteSchema).optional(),
  title: z.string(),
}))

const playwrightReportSchema = z.object({
  errors: z.array(playwrightErrorSchema).optional(),
  suites: z.array(playwrightSuiteSchema),
})

type PlaywrightResult = z.infer<typeof playwrightResultSchema>
type PlaywrightSpec = z.infer<typeof playwrightSpecSchema>
type PlaywrightTest = z.infer<typeof playwrightTestSchema>

interface MutableScanTest {
  counts: ScanCounts
  failureClusters: FailureClusterMap
  identity: ScanTestResult["identity"]
}

export interface NativeScanOptions {
  artifactDirectory: string
  artifactRoot?: string
  configPath?: string
  environment?: NodeJS.ProcessEnv
  playwrightCliPath?: string
  runs: number
  signal?: AbortSignal
  temporaryParent?: string
  workers: number
}

export interface NativeScanResult {
  exitCode: number | null
  playwrightOutputDirectory: string | null
  runnerErrors: string[]
  tests: ScanTestResult[]
}

type NativeScanExecutionResult = Omit<NativeScanResult, "playwrightOutputDirectory">

export function failureConfidence(
  failures: number,
  trials: number,
): { lowerBound80: number; upperBound80: number } {
  if (trials === 0) {
    return { lowerBound80: 0, upperBound80: 0 }
  }
  const probability = failures / trials
  const squaredZ = WILSON_Z_80 ** 2
  const denominator = 1 + squaredZ / trials
  const center = probability + squaredZ / (2 * trials)
  const margin = WILSON_Z_80 * Math.sqrt(
    (probability * (1 - probability) + squaredZ / (4 * trials)) / trials,
  )
  return {
    lowerBound80: Math.max(0, (center - margin) / denominator),
    upperBound80: Math.min(1, (center + margin) / denominator),
  }
}

export function nativeScanArguments(
  playwrightCliPath: string,
  target: string,
  options: Pick<NativeScanOptions, "configPath" | "runs" | "workers">,
  outputDirectory: string,
): string[] {
  return [
    playwrightCliPath,
    "test",
    target,
    `--repeat-each=${options.runs}`,
    `--workers=${options.workers}`,
    "--retries=0",
    "--reporter=json",
    `--output=${outputDirectory}`,
    ...(options.configPath ? ["--config", options.configPath] : []),
  ]
}

function validateOptions(options: NativeScanOptions): void {
  if (!Number.isInteger(options.runs) || options.runs < 2 || options.runs > 100) {
    throw new Error("runs must be an integer between 2 and 100")
  }
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 32) {
    throw new Error("concurrency must be an integer between 1 and 32")
  }
}

function classifyTest(counts: ScanCounts): ScanTestStatus {
  if (counts.errors > 0) {
    return "errored"
  }
  if (counts.passed === 0 && counts.failed === 0) {
    return "skipped"
  }
  if (counts.failed === 0) {
    return "no-failure-observed"
  }
  if (counts.passed === 0) {
    return "failed-every-run"
  }
  return "mixed-outcomes"
}

function outcome(
  resultStatus: PlaywrightResult["status"],
  testStatus: PlaywrightTest["status"],
): keyof ScanCounts {
  if (resultStatus === "interrupted") {
    return "errors"
  }
  if (resultStatus === "skipped" || testStatus === "skipped") {
    return "skipped"
  }
  if (resultStatus === "passed") {
    return "passed"
  }
  if (testStatus === "expected") {
    return "passed"
  }
  return "failed"
}

function cleanFailureReason(message: string): string {
  return redactText(normalizeFailureOutput(message)).slice(0, 2_000)
}

function identityKey(identity: ScanTestResult["identity"]): string {
  return JSON.stringify(identity)
}

function createMutableTest(
  titlePath: string[],
  spec: PlaywrightSpec,
  test: PlaywrightTest,
): MutableScanTest {
  const normalizedFile = spec.file.replaceAll("\\", "/")
  const testTitles = titlePath
    .filter((title) => title.replaceAll("\\", "/") !== normalizedFile)
  return {
    counts: { errors: 0, failed: 0, passed: 0, skipped: 0 },
    failureClusters: new Map(),
    identity: {
      column: spec.column,
      file: spec.file,
      line: spec.line,
      project: test.projectName,
      titlePath: [...testTitles, spec.title].filter(Boolean),
    },
  }
}

function failureArtifacts(result: PlaywrightResult): FailureObservation["artifacts"] {
  return (result.attachments ?? []).flatMap((attachment) => attachment.path ? [{
    contentType: attachment.contentType,
    name: attachment.name,
    path: redactText(attachment.path),
  }] : [])
}

function failureReason(result: PlaywrightResult): string {
  const reasons = (result.errors ?? []).flatMap((error) => (
    error.message ? [cleanFailureReason(error.message)] : []
  ))
  return reasons.length > 0 ? reasons.join("\n---\n").slice(0, 2_000) : "playwright-exit-failure"
}

function attemptNumber(counts: ScanCounts): number {
  return counts.passed + counts.failed + counts.skipped + counts.errors + 1
}

function recordResult(
  entry: MutableScanTest,
  result: PlaywrightResult,
  testStatus: PlaywrightTest["status"],
): void {
  const attempt = attemptNumber(entry.counts)
  const resultOutcome = outcome(result.status, testStatus)
  entry.counts[resultOutcome] += 1
  if (resultOutcome !== "failed") {
    return
  }
  recordFailureObservation(entry.failureClusters, {
    artifacts: failureArtifacts(result),
    attempt,
    reason: failureReason(result),
  })
}

function recordTest(entry: MutableScanTest, test: PlaywrightTest): void {
  if (test.results.length === 0) {
    entry.counts[test.status === "skipped" ? "skipped" : "errors"] += 1
    return
  }
  for (const result of test.results) {
    recordResult(entry, result, test.status)
  }
}

function collectSuite(
  suite: PlaywrightSuite,
  parentTitles: string[],
  entries: Map<string, MutableScanTest>,
): void {
  const titlePath = suite.title ? [...parentTitles, suite.title] : parentTitles
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      const candidate = createMutableTest(titlePath, spec, test)
      const key = identityKey(candidate.identity)
      const entry = entries.get(key) ?? candidate
      recordTest(entry, test)
      entries.set(key, entry)
    }
  }
  for (const child of suite.suites ?? []) {
    collectSuite(child, titlePath, entries)
  }
}

function finalizeTest(entry: MutableScanTest): ScanTestResult {
  const measuredTrials = entry.counts.passed + entry.counts.failed
  const trials = measuredTrials + entry.counts.skipped + entry.counts.errors
  const confidence = failureConfidence(entry.counts.failed, measuredTrials)
  return {
    counts: entry.counts,
    ...finalizeFailureClusters(entry.failureClusters, measuredTrials),
    failureRate: measuredTrials === 0 ? 0 : entry.counts.failed / measuredTrials,
    identity: entry.identity,
    ...confidence,
    status: classifyTest(entry.counts),
    trials,
  }
}

function compareTests(left: ScanTestResult, right: ScanTestResult): number {
  return identityKey(left.identity).localeCompare(identityKey(right.identity))
}

export function parseNativeScanReport(reportText: string, projectRoot: string): {
  runnerErrors: string[]
  tests: ScanTestResult[]
} {
  const report = playwrightReportSchema.parse(JSON.parse(reportText))
  const entries = new Map<string, MutableScanTest>()
  for (const suite of report.suites) {
    collectSuite(suite, [], entries)
  }
  const runnerErrors = (report.errors ?? [])
    .flatMap((error) => error.message ? [cleanFailureReason(error.message)] : [])
  return {
    runnerErrors,
    tests: [...entries.values()]
      .map(finalizeTest)
      .map((test) => portableScanTestPaths(test, projectRoot))
      .sort(compareTests),
  }
}

function safeProcessError(value: string): string {
  return cleanFailureReason(value || "Playwright process failed before producing a report.")
}

function earlyProcessResult(
  execution: CapturedProcessResult,
  aborted: boolean,
): NativeScanExecutionResult | undefined {
  if (execution.spawnError) {
    return {
      exitCode: null,
      runnerErrors: [safeProcessError(execution.spawnError)],
      tests: [],
    }
  }
  if (aborted) {
    return {
      exitCode: execution.exitCode,
      runnerErrors: ["Playwright scan was interrupted."],
      tests: [],
    }
  }
  return undefined
}

async function readCompletedReport(
  reportPath: string,
  execution: CapturedProcessResult,
  projectRoot: string,
): Promise<NativeScanExecutionResult> {
  try {
    const parsed = parseNativeScanReport(await readFile(reportPath, "utf8"), projectRoot)
    if (parsed.tests.length === 0 && parsed.runnerErrors.length === 0) {
      parsed.runnerErrors.push("Playwright did not report any matching tests.")
    }
    const hasTestFailure = parsed.tests.some((test) => test.counts.failed > 0)
    if (execution.exitCode !== 0 && !hasTestFailure && parsed.runnerErrors.length === 0) {
      parsed.runnerErrors.push(safeProcessError(execution.diagnostic))
    }
    return {
      exitCode: execution.exitCode,
      ...parsed,
    }
  } catch {
    return {
      exitCode: execution.exitCode,
      runnerErrors: ["Playwright produced a missing or malformed JSON report."],
      tests: [],
    }
  }
}

async function removeTemporaryDirectory(parent: string, directory: string): Promise<void> {
  const childPath = relative(resolve(parent), resolve(directory))
  if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) {
    throw new Error("Refusing to clean a temporary path outside its parent")
  }
  await rm(directory, { force: true, recursive: true })
}

export async function runNativePlaywrightScan(
  projectRoot: string,
  target: string,
  options: NativeScanOptions,
): Promise<NativeScanResult> {
  validateOptions(options)
  const temporaryParent = resolve(options.temporaryParent ?? tmpdir())
  await mkdir(temporaryParent, { recursive: true })
  const temporaryDirectory = await mkdtemp(join(temporaryParent, "flakelab-scan-"))
  const reportPath = join(temporaryDirectory, "playwright-report.json")
  const artifactRoot = resolve(options.artifactRoot ?? projectRoot)
  const playwrightOutputDirectory = join(
    resolve(artifactRoot, options.artifactDirectory),
    "playwright",
    randomUUID(),
  )
  const playwrightCliPath = options.playwrightCliPath ?? resolvePlaywrightCliPath(projectRoot)
  const child = spawn(
    process.execPath,
    nativeScanArguments(playwrightCliPath, target, options, playwrightOutputDirectory),
    {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      env: {
        ...createPlaywrightEnvironment({ ...process.env, ...options.environment }),
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      },
      shell: false,
      windowsHide: true,
    },
  )

  let result: NativeScanExecutionResult
  try {
    const execution = await waitForProcessTree(child, options.signal)
    const earlyResult = earlyProcessResult(
      execution,
      options.signal?.aborted === true,
    )
    if (earlyResult) {
      result = earlyResult
    } else {
      result = await readCompletedReport(reportPath, execution, artifactRoot)
    }
  } finally {
    await removeTemporaryDirectory(temporaryParent, temporaryDirectory)
  }
  return {
    ...result,
    playwrightOutputDirectory: await retainOwnedArtifacts(
      artifactRoot,
      playwrightOutputDirectory,
    ),
  }
}
