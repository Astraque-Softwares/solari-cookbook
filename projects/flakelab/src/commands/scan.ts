import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import type { ExperimentResult } from "../discovery/evaluate.js"
import { evaluateExperiment } from "../discovery/evaluate.js"
import { createPlaywrightExecutor } from "../runner/playwright-executor.js"
import { ProgressReporter } from "../ui/progress.js"
import type { CliValues } from "./options.js"
import { integerOption, withInterruption } from "./options.js"

export type ScanStatus =
  | "consistent-failure"
  | "flaky"
  | "inconclusive"
  | "no-failure-observed"

export interface ScanResult {
  artifactPath: string
  result: ExperimentResult
  status: ScanStatus
  target: string
}

export function classifyScan(result: ExperimentResult): ScanStatus {
  if (result.errors > 0) {
    return "inconclusive"
  }
  if (result.failed === 0) {
    return "no-failure-observed"
  }
  if (result.passed === 0) {
    return "consistent-failure"
  }
  return "flaky"
}

function percentage(value: number): string {
  return `${Math.round(value * 100)}%`
}

function finding(status: ScanStatus): string {
  const findings: Record<ScanStatus, string> = {
    "consistent-failure": "The target failed consistently; this looks like a regular test failure.",
    flaky: "Flaky behavior observed: the same target both passed and failed.",
    inconclusive: "The scan was inconclusive because one or more test processes could not run.",
    "no-failure-observed": "No failure was observed in this bounded scan.",
  }
  return findings[status]
}

export function formatScanSummary(scan: ScanResult): string {
  const lines = [
    "",
    "FlakeLab stability scan",
    `  Target       ${scan.target}`,
    `  Runs         ${scan.result.trials}`,
    `  Passed       ${scan.result.passed}`,
    `  Failed       ${scan.result.failed}`,
    `  Failure rate ${percentage(scan.result.failureRate)}`,
    "",
    finding(scan.status),
  ]
  if (scan.result.dominantFailureReason) {
    const reason = scan.result.dominantFailureReason
      .split("\n")
      .map((line) => `  ${line}`)
    lines.push("", "Most common failure", ...reason)
  }
  lines.push("", `Evidence saved to ${scan.artifactPath}`)
  if (scan.status === "no-failure-observed") {
    lines.push("Run again with --runs 20 for a stronger scan.")
  }
  return lines.join("\n")
}

export async function scan(target: string, values: CliValues): Promise<ScanResult> {
  const projectRoot = process.cwd()
  const artifactPath = resolve(projectRoot, values.artifacts, "scan.json")
  const progress = new ProgressReporter()
  const runs = integerOption(values.runs, "runs")
  progress.start(`Running ${runs} isolated Playwright repetitions`)
  const result = await withInterruption(async (signal) => evaluateExperiment(
    createPlaywrightExecutor(projectRoot, target, { signal }),
    {
      concurrency: integerOption(values.concurrency, "concurrency"),
      minimumFailureRate: 0.5,
      seed: integerOption(values.seed, "seed"),
      signal,
      trials: runs,
    },
  ))
  progress.done(`${result.passed} passed · ${result.failed} failed · ${result.errors} errors`)
  const scanResult: ScanResult = {
    artifactPath,
    result,
    status: classifyScan(result),
    target,
  }
  await mkdir(dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, `${JSON.stringify(scanResult, null, 2)}\n`, "utf8")
  process.stdout.write(`${formatScanSummary(scanResult)}\n`)
  if (values.verbose) {
    process.stdout.write(`\n${JSON.stringify(scanResult, null, 2)}\n`)
  }
  if (scanResult.status !== "no-failure-observed") {
    process.exitCode = 1
  }
  return scanResult
}
