import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"


import { createNdjsonWriter } from "../../src/artifacts/ndjson.js"
import { runEventSchema, runRequestSchema } from "../../src/domain/schema.js"
import { runLocalDiagnostics } from "../../src/runner/local.js"

test("runner records complete events and separates baseline from fault failures", async ({
  browserName: _browserName,
}, testInfo) => {
  const eventPath = testInfo.outputPath("events.ndjson")
  const request = runRequestSchema.parse({
    selector: "checkout.spec.ts",
    runs: 2,
    seed: 7,
    artifactDirectory: testInfo.outputDir,
    fault: { kind: "network-delay", pattern: "**/api/checkout", delayMs: 250 },
  })

  const result = await runLocalDiagnostics(
    request,
    (trial) => Promise.resolve({
      status: trial.fault ? "failed" : "passed",
      durationMs: 10,
      exitCode: trial.fault ? 1 : 0,
      ...(trial.fault ? { failureSignature: "checkout-timeout" } : {}),
    }),
    createNdjsonWriter(eventPath),
  )

  expect(result.summary).toEqual({
    total: 2,
    passed: 1,
    failed: 1,
    errors: 0,
    baselineFailureRate: 0,
    faultFailureRate: 1,
  })
  const events = (await readFile(eventPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => runEventSchema.parse(JSON.parse(line)))
  expect(events.map((entry) => entry.type)).toEqual([
    "run.started",
    "trial.started",
    "trial.completed",
    "trial.started",
    "trial.completed",
    "run.completed",
  ])
})

test("runner stops scheduling trials after an interruption", async ({
  browserName: _browserName,
}, testInfo) => {
  const abortController = new AbortController()
  let executionCount = 0
  const request = runRequestSchema.parse({
    selector: "checkout.spec.ts",
    runs: 4,
    seed: 7,
    artifactDirectory: testInfo.outputDir,
    fault: { kind: "network-delay", pattern: "**/api/checkout", delayMs: 250 },
  })

  const result = await runLocalDiagnostics(request, () => {
    executionCount += 1
    abortController.abort()
    return Promise.resolve({ status: "passed", durationMs: 10, exitCode: 0 })
  }, createNdjsonWriter(testInfo.outputPath("interrupted.ndjson")), {
    signal: abortController.signal,
  })

  expect(executionCount).toBe(1)
  expect(result.summary.total).toBe(1)
})

test("runner respects its parallelism bound", async ({ browserName: _browserName }, testInfo) => {
  let activeExecutions = 0
  let maximumActiveExecutions = 0
  let releasePair = (): void => undefined
  const pairStarted = new Promise<void>((resolve) => {
    releasePair = resolve
  })
  const request = runRequestSchema.parse({
    selector: "checkout.spec.ts",
    runs: 4,
    seed: 7,
    artifactDirectory: testInfo.outputDir,
    fault: { kind: "network-delay", pattern: "**/api/checkout", delayMs: 250 },
  })

  const result = await runLocalDiagnostics(request, async () => {
    activeExecutions += 1
    maximumActiveExecutions = Math.max(maximumActiveExecutions, activeExecutions)
    if (activeExecutions === 2) {
      releasePair()
    }
    await pairStarted
    activeExecutions -= 1
    return { status: "passed", durationMs: 1, exitCode: 0 }
  }, createNdjsonWriter(testInfo.outputPath("parallel.ndjson")), { concurrency: 2 })

  expect(result.summary.total).toBe(4)
  expect(maximumActiveExecutions).toBe(2)
})
