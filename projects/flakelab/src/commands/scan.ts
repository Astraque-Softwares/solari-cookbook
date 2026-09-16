import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { portableProjectPath } from "../artifacts/paths.js"
import {
  discoverRepositoryProfile,
  repositoryEnvironment,
  writeRepositoryProfile,
} from "../project/profile.js"
import type { RepositoryProfile } from "../project/schema.js"
import { failureConfidence, runNativePlaywrightScan } from "../runner/native-scan.js"
import type {
  ScanArtifact,
  ScanCounts,
  ScanStatus,
  ScanTestResult,
  ScanTotals,
} from "../scan/schema.js"
import { scanArtifactSchema } from "../scan/schema.js"
import { ProgressReporter } from "../ui/progress.js"
import { formatCount } from "../ui/format.js"
import { writeStdout } from "../ui/console.js"
import { stdoutTheme } from "../ui/theme.js"
import { formatScanOutput } from "./scan-summary.js"
import type { ScanOptions } from "./options.js"
import { integerOption, withInterruption } from "./options.js"

export type { ScanStatus } from "../scan/schema.js"
export type ScanResult = ScanArtifact

export {
  failureEvidence,
  finding,
  formatScanOutput,
  formatScanSummary,
} from "./scan-summary.js"

const SCAN_EXIT_CODES: Record<ScanStatus, 0 | 1 | 2> = {
  "failed-every-run": 1,
  inconclusive: 2,
  "mixed-outcomes": 1,
  "no-failure-observed": 0,
}

function sumCounts(tests: ScanTestResult[]): ScanCounts {
  return tests.reduce<ScanCounts>((total, test) => ({
    errors: total.errors + test.counts.errors,
    failed: total.failed + test.counts.failed,
    passed: total.passed + test.counts.passed,
    skipped: total.skipped + test.counts.skipped,
  }), { errors: 0, failed: 0, passed: 0, skipped: 0 })
}

export function classifyScan(tests: ScanTestResult[], runnerErrors: string[]): ScanStatus {
  if (runnerErrors.length > 0 || tests.length === 0 || tests.every((test) => test.status === "skipped")) {
    return "inconclusive"
  }
  if (tests.some((test) => test.status === "errored")) {
    return "inconclusive"
  }
  if (tests.some((test) => test.status === "mixed-outcomes")) {
    return "mixed-outcomes"
  }
  if (tests.some((test) => test.status === "failed-every-run")) {
    return "failed-every-run"
  }
  return "no-failure-observed"
}

export function scanExitCode(status: ScanStatus): 0 | 1 | 2 {
  return SCAN_EXIT_CODES[status]
}

export function summarizeScanTests(tests: ScanTestResult[]): ScanTotals {
  const counts = sumCounts(tests)
  const measuredTrials = counts.passed + counts.failed
  return {
    ...counts,
    executions: measuredTrials + counts.skipped + counts.errors,
    failureRate: measuredTrials === 0 ? 0 : counts.failed / measuredTrials,
    lowerBound80: failureConfidence(counts.failed, measuredTrials).lowerBound80,
    upperBound80: failureConfidence(counts.failed, measuredTrials).upperBound80,
  }
}

export async function scan(
  target: string,
  values: ScanOptions,
  repository?: RepositoryProfile,
): Promise<ScanResult> {
  const profile = repository ?? await discoverRepositoryProfile({
    artifactDirectory: values.artifacts,
    config: values.config,
    invocationRoot: process.cwd(),
    target,
  })
  await writeRepositoryProfile(profile, values.artifacts)
  const projectRoot = profile.artifactRoot
  const artifactPath = resolve(projectRoot, values.artifacts, "scan.json")
  const portableArtifactPath = portableProjectPath(projectRoot, artifactPath)
  const progress = new ProgressReporter()
  const runs = integerOption(values.runs, "runs")
  const workers = integerOption(values.concurrency, "concurrency")
  progress.start(
    "stability scan",
    `${formatCount(runs, "native Playwright run")} · ${formatCount(workers, "worker")}`,
  )
  const nativeResult = await withInterruption(async (signal) => runNativePlaywrightScan(
    profile.executionRoot,
    profile.playwright.target,
    {
      artifactDirectory: values.artifacts,
      artifactRoot: profile.artifactRoot,
      configPath: profile.playwright.configPath,
      environment: repositoryEnvironment(profile),
      playwrightCliPath: profile.playwright.cliPath,
      runs,
      signal,
      workers,
    },
  ))
  const status = classifyScan(nativeResult.tests, nativeResult.runnerErrors)
  progress.done(
    `${status} · ${formatCount(nativeResult.tests.length, "test")} classified`
    + ` · ${formatCount(nativeResult.runnerErrors.length, "runner error")}`,
  )
  const scanResult = scanArtifactSchema.parse({
    generatedAt: new Date().toISOString(),
    playwrightOutputDirectory: nativeResult.playwrightOutputDirectory,
    runs,
    runnerErrors: nativeResult.runnerErrors,
    status,
    target: profile.playwright.target,
    tests: nativeResult.tests,
    totals: summarizeScanTests(nativeResult.tests),
    workers,
  })
  await mkdir(dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, `${JSON.stringify(scanResult, null, 2)}\n`, "utf8")
  writeStdout(formatScanOutput(scanResult, values, portableArtifactPath, stdoutTheme()))
  process.exitCode = scanExitCode(scanResult.status)
  return scanResult
}
