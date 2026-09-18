import { expect, test } from "@playwright/test"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"


import { createNdjsonWriter } from "../../src/artifacts/ndjson.js"
import { runEventSchema, runRequestSchema } from "../../src/domain/schema.js"
import { runLocalDiagnostics } from "../../src/runner/local.js"
import {
  createTrialEnvironment,
  createPlaywrightExecutor,
  normalizeFailureOutput,
  resolvePlaywrightCliPath,
  trialOutputDirectory,
} from "../../src/runner/playwright-executor.js"

test("runner keeps provider credentials out of Playwright processes", () => {
  const environment = createTrialEnvironment({
    trialId: "trial-1",
    index: 0,
    seed: 7,
    faults: [],
  }, {
    APP_DATABASE_URL: "postgresql://application.test/database",
    FLAKELAB_TRIAL_SEED: "spoofed",
    GROQ_API_KEY: "groq-value",
    SOLARI_API_KEY: "solari-value",
  })

  expect(environment).toMatchObject({
    APP_DATABASE_URL: "postgresql://application.test/database",
    FLAKELAB_TRIAL_SEED: "7",
  })
  expect(environment.GROQ_API_KEY).toBeUndefined()
  expect(environment.SOLARI_API_KEY).toBeUndefined()
})

test("runner confines every trial to a distinct Playwright output directory", () => {
  const projectRoot = join("workspace", "consumer")
  const first = trialOutputDirectory(projectRoot, "run-one", {
    trialId: "../../first",
    index: 0,
    seed: 7,
    faults: [],
  })
  const second = trialOutputDirectory(projectRoot, "run-one", {
    trialId: "../../second",
    index: 1,
    seed: 8,
    faults: [],
  })
  const otherRun = trialOutputDirectory(projectRoot, "run-two", {
    trialId: "../../first",
    index: 0,
    seed: 7,
    faults: [],
  })

  expect(first).toContain(join(projectRoot, ".flakelab", "test-results"))
  expect(first).not.toContain("..")
  expect(new Set([first, second, otherRun]).size).toBe(3)
})

test("runner attributes diagnostics to the failed test instead of a progress line", () => {
  const output = [
    "[1/58] [chromium] › tests/core/bisect.spec.ts:45:1 › classifies confidence",
    "1) [chromium] › tests/core/report.spec.ts:143:1 › renders its evidence",
    "Error: expect(locator).toBeVisible() failed",
    "Locator: getByRole('heading', { name: 'Verdict' })",
    "Expected: visible",
  ].join("\n")

  const normalized = normalizeFailureOutput(output)

  expect(normalized).toContain("tests/core/report.spec.ts:<line>")
  expect(normalized).toContain("Locator: getByRole('heading', { name: 'Verdict' })")
  expect(normalized).not.toContain("bisect.spec.ts")
})

test("runner prefers the Playwright installation belonging to the scanned project", async ({
  browserName: _browserName,
}, testInfo) => {
  const project = testInfo.outputPath("consumer")
  const packageRoot = join(project, "node_modules", "@playwright", "test")
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(project, "package.json"), "{}\n", "utf8")
  await writeFile(join(packageRoot, "cli.js"), "export {}\n", "utf8")
  await writeFile(
    join(packageRoot, "package.json"),
    '{"name":"@playwright/test","exports":{"./cli":"./cli.js"}}\n',
    "utf8",
  )

  expect(resolvePlaywrightCliPath(project)).toBe(join(packageRoot, "cli.js"))
})

test("investigation mode retains project-relative trace evidence", async () => {
  const projectRoot = process.cwd()
  const execute = createPlaywrightExecutor(
    projectRoot,
    "tests/fixtures/checkout-regression.spec.ts",
    { captureTrace: true },
  )
  const outcome = await execute({
    faults: [],
    index: 0,
    seed: 7,
    trialId: "evidence-1",
  })

  expect(outcome.status).toBe("passed")
  const trace = outcome.artifacts?.find((artifact) => artifact.name === "trace")
  expect(trace?.contentType).toBe("application/zip")
  expect(trace?.path).toMatch(/^\.flakelab\/test-results\//u)
  await expect(lstat(join(projectRoot, trace?.path ?? "missing"))).resolves.toBeDefined()
})

test("runner injects request faults into ordinary Playwright tests", async () => {
  test.slow()
  const projectRoot = process.cwd()
  const execute = createPlaywrightExecutor(projectRoot, "tests/fixtures/flaky-checkout.spec.ts")
  const baseline = await execute({ trialId: "baseline-before", index: 0, seed: 7, faults: [] })
  const delayed = await execute({
    trialId: "delayed",
    index: 1,
    seed: 8,
    faults: [{ kind: "network-delay", pattern: "**/api/checkout", delayMs: 125 }],
  })
  const unavailable = await execute({
    trialId: "unavailable",
    index: 2,
    seed: 9,
    faults: [{ kind: "request-failure", pattern: "**/api/checkout", statusCode: 503 }],
  })
  const baselineAfter = await execute({
    trialId: "baseline-after",
    index: 3,
    seed: 10,
    faults: [],
  })

  expect(baseline.status).toBe("passed")
  expect(delayed.status).toBe("failed")
  expect(delayed.failureReason).toContain("checkout completes before the product deadline")
  expect(unavailable.status).toBe("failed")
  expect(unavailable.failureReason).toContain("checkout completes before the product deadline")
  expect(baselineAfter.status).toBe("passed")
})

test("discovery controls traverse a no-op proxy without changing the outcome", async () => {
  test.slow()
  const execute = createPlaywrightExecutor(
    process.cwd(),
    "tests/fixtures/checkout-regression.spec.ts",
    { proxyMode: "always" },
  )
  const outcome = await execute({
    faults: [],
    index: 0,
    seed: 7,
    trialId: "no-op-proxy-control",
  })

  expect(outcome).toMatchObject({ status: "passed" })
})

test("runner injects response and loading faults into ordinary Playwright tests", async () => {
  test.slow()
  const projectRoot = process.cwd()
  const executePayload = createPlaywrightExecutor(
    projectRoot,
    "tests/fixtures/response-payload.spec.ts",
  )
  const executeOrder = createPlaywrightExecutor(
    projectRoot,
    "tests/fixtures/response-order.spec.ts",
  )
  const executeStartup = createPlaywrightExecutor(
    projectRoot,
    "tests/fixtures/startup-script.spec.ts",
  )
  const truncated = await executePayload({
    trialId: "truncated",
    index: 3,
    seed: 10,
    faults: [
      { kind: "network-delay", pattern: "**/api/checkout", delayMs: 10 },
      { kind: "response-truncation", pattern: "**/api/checkout", removeBytes: 1 },
    ],
  })
  const duplicated = await executePayload({
    trialId: "duplicated",
    index: 4,
    seed: 11,
    faults: [{
      kind: "response-duplication",
      pattern: "**/api/checkout",
      duplicateBytes: 1,
    }],
  })
  const orderedComposition = await executePayload({
    trialId: "ordered-composition",
    index: 5,
    seed: 12,
    faults: [
      {
        kind: "response-duplication",
        pattern: "**/api/checkout",
        duplicateBytes: 1,
      },
      {
        kind: "response-truncation",
        pattern: "**/api/checkout",
        removeBytes: 1,
      },
    ],
  })
  const reordered = await executeOrder({
    trialId: "reordered",
    index: 6,
    seed: 13,
    faults: [{
      kind: "response-reordering",
      pattern: "**/api/order*",
      holdMs: 100,
    }],
  })
  const startupDelayed = await executeStartup({
    trialId: "startup-delayed",
    index: 7,
    seed: 14,
    faults: [{
      kind: "resource-loading-delay",
      pattern: "**/assets/*",
      resourceType: "script",
      delayMs: 750,
    }],
  })
  expect(truncated.status).toBe("failed")
  expect(truncated.failureReason).toContain("checkout API returns a complete JSON payload")
  expect(duplicated.status).toBe("failed")
  expect(duplicated.failureReason).toContain("checkout API returns a complete JSON payload")
  expect(orderedComposition.status).toBe("passed")
  expect(reordered.status).toBe("failed")
  expect(reordered.failureReason).toContain("concurrent API responses preserve request order")
  expect(startupDelayed.status).toBe("failed")
  expect(startupDelayed.failureReason).toContain("startup script hydrates before the application deadline")
})

test("runner injects document bootstrap faults", async () => {
  test.slow()
  const projectRoot = process.cwd()
  const executeHydration = createPlaywrightExecutor(
    projectRoot,
    "tests/fixtures/hydration-event.spec.ts",
  )
  const executeEventLoop = createPlaywrightExecutor(
    projectRoot,
    "tests/fixtures/event-loop.spec.ts",
  )
  const hydrationDelayed = await executeHydration({
    trialId: "hydration-delayed",
    index: 0,
    seed: 15,
    faults: [{
      kind: "startup-event-delay",
      pattern: "**/hydration",
      event: "dom-content-loaded",
      delayMs: 750,
    }],
  })
  const eventLoopStalled = await executeEventLoop({
    trialId: "event-loop-stalled",
    index: 1,
    seed: 16,
    faults: [{
      kind: "event-loop-stall",
      pattern: "**/event-loop",
      startAfterMs: 0,
      durationMs: 400,
    }],
  })

  expect(hydrationDelayed.status).toBe("failed")
  expect(hydrationDelayed.failureReason).toContain("application hydrates when DOM content becomes ready")
  expect(eventLoopStalled.status).toBe("failed")
  expect(eventLoopStalled.failureReason).toContain("application becomes interactive within its main-thread budget")
})

test("runner injects authentication and browser-storage faults", async () => {
  test.slow()
  const projectRoot = process.cwd()
  const executeCookie = createPlaywrightExecutor(
    projectRoot,
    "tests/fixtures/auth-cookie.spec.ts",
  )
  const executeStorage = createPlaywrightExecutor(
    projectRoot,
    "tests/fixtures/storage-state.spec.ts",
  )

  const expiredCookie = await executeCookie({
    trialId: "expired-cookie",
    index: 0,
    seed: 17,
    faults: [{
      kind: "auth-cookie-expiry",
      pattern: "**/cookie-auth",
      cookieName: "session-id",
    }],
  })
  const delayedStorage = await executeStorage({
    trialId: "delayed-storage",
    index: 1,
    seed: 18,
    faults: [{
      kind: "storage-state-delay",
      pattern: "**/storage-auth",
      storage: "local-storage",
      key: "auth-token",
      delayMs: 250,
    }],
  })

  expect(expiredCookie.status).toBe("failed")
  expect(expiredCookie.failureReason).toContain("an active session cookie authenticates the request")
  expect(delayedStorage.status).toBe("failed")
  expect(delayedStorage.failureReason).toContain("application reads its initialized browser storage")
})

test("runner injects clock, locale, and timezone faults", async () => {
  test.slow()
  const execute = createPlaywrightExecutor(
    process.cwd(),
    "tests/fixtures/temporal-environment.spec.ts",
  )
  const clock = await execute({
    trialId: "clock-jump",
    index: 0,
    seed: 19,
    faults: [{
      kind: "clock-jump",
      pattern: "**/temporal",
      jumpAfterMs: 25,
      offsetMs: 3_600_000,
    }],
  })
  const locale = await execute({
    trialId: "locale",
    index: 1,
    seed: 20,
    faults: [{ kind: "locale", pattern: "**/temporal", locale: "fr-FR" }],
  })
  const timezone = await execute({
    trialId: "timezone",
    index: 2,
    seed: 21,
    faults: [{
      kind: "timezone",
      pattern: "**/temporal",
      timezoneId: "America/New_York",
    }],
  })

  expect(clock.failureReason).toContain("wall clock remains monotonic")
  expect(locale.failureReason).toContain("application uses its configured locale")
  expect(timezone.failureReason).toContain("application uses its configured timezone")
})

test("runner injects viewport, reduced-motion, and animation-speed faults", async () => {
  test.slow()
  const execute = createPlaywrightExecutor(
    process.cwd(),
    "tests/fixtures/visual-environment.spec.ts",
  )
  const viewport = await execute({
    trialId: "viewport",
    index: 0,
    seed: 22,
    faults: [{
      kind: "viewport",
      pattern: "**/visual-environment",
      width: 375,
      height: 667,
    }],
  })
  const motion = await execute({
    trialId: "reduced-motion",
    index: 1,
    seed: 23,
    faults: [{ kind: "reduced-motion", pattern: "**/never-matches" }],
  })
  const animation = await execute({
    trialId: "animation-speed",
    index: 2,
    seed: 24,
    faults: [{ kind: "animation-speed", pattern: "**/visual-environment", rate: 10 }],
  })

  expect(viewport.failureReason).toContain("application renders its desktop layout")
  expect(motion.failureReason).toContain("application uses full motion")
  expect(animation.failureReason).toContain("application animation keeps its expected duration")
})

test("runner records complete events and separates baseline from fault failures", async ({
  browserName: _browserName,
}, testInfo) => {
  const eventPath = testInfo.outputPath("events.ndjson")
  const request = runRequestSchema.parse({
    selector: "checkout.spec.ts",
    runs: 2,
    seed: 7,
    artifactDirectory: testInfo.outputDir,
    faults: [{ kind: "network-delay", pattern: "**/api/checkout", delayMs: 250 }],
  })

  const result = await runLocalDiagnostics(
    request,
    (trial) => Promise.resolve({
      status: trial.faults.length > 0 ? "failed" : "passed",
      durationMs: 10,
      exitCode: trial.faults.length > 0 ? 1 : 0,
      ...(trial.faults.length > 0 ? { failureSignature: "checkout-timeout" } : {}),
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
    faults: [{ kind: "network-delay", pattern: "**/api/checkout", delayMs: 250 }],
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
    faults: [{ kind: "network-delay", pattern: "**/api/checkout", delayMs: 250 }],
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
