import { expect, test } from "@playwright/test"

import { classifyScan, formatScanSummary } from "../../src/commands/scan.js"
import type { ExperimentResult } from "../../src/discovery/evaluate.js"

function result(passed: number, failed: number, errors = 0): ExperimentResult {
  const trials = passed + failed + errors
  return {
    confirmed: false,
    errors,
    failed,
    failureRate: trials === 0 ? 0 : failed / trials,
    lowerBound80: 0,
    passed,
    trials,
  }
}

test("stability scan distinguishes flakes from consistent failures", () => {
  expect(classifyScan(result(4, 0))).toBe("no-failure-observed")
  expect(classifyScan(result(3, 1))).toBe("flaky")
  expect(classifyScan(result(0, 4))).toBe("consistent-failure")
  expect(classifyScan(result(0, 0, 1))).toBe("inconclusive")
})

test("stability scan summary gives a user a result and next action", () => {
  const summary = formatScanSummary({
    artifactPath: ".flakelab/runs/scan.json",
    result: result(4, 0),
    status: "no-failure-observed",
    target: "tests/checkout.spec.ts",
  })

  expect(summary).toContain("No failure was observed")
  expect(summary).toContain("--runs 20")
  expect(summary).toContain(".flakelab/runs/scan.json")
})
