import { expect, test } from "@playwright/test"

import {
  automaticFaultCandidates,
  automaticScreeningTrialBound,
  NoAutomaticFaultSignalError,
  selectAutomaticFault,
} from "../../src/discovery/automatic.js"

const automaticOptions = {
  animationRate: 5,
  capabilities: { selectedTestCount: 1 },
  clockOffsetMs: 3_600_000,
  concurrency: 2,
  eventLoopDurationMs: 500,
  holdMs: 250,
  locale: "fr-FR",
  maximumDelayMs: 1_000,
  maximumDuplicateBytes: 1_024,
  maximumRemoveBytes: 1_024,
  minimumFailureRate: 0.7,
  pattern: "**/data/items*",
  seed: 42,
  selector: "tests/items.spec.ts:12",
  startupEvent: "dom-content-loaded" as const,
  timezoneId: "America/New_York",
  trials: 4,
  viewportHeight: 667,
  viewportWidth: 375,
}

test("automatic discovery stops scheduling after an exploratory signal", async () => {
  const selected = await selectAutomaticFault((trial) => {
    const failed = trial.faults.some((fault) => fault.kind === "response-truncation")
    return Promise.resolve({
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "partial-data" } : {}),
      status: failed ? "failed" as const : "passed" as const,
    })
  }, automaticOptions)

  expect(selected.fault.kind).toBe("response-truncation")
  expect(selected.screenings.find((entry) => entry.fault.kind === "network-delay"))
    .toMatchObject({ coverage: "screened", failed: 0, passed: 1 })
  expect(selected.screenings.find((entry) => entry.fault.kind === "response-truncation"))
    .toMatchObject({ coverage: "screened", failed: 1, passed: 0 })
  expect(selected.screenings.some((entry) => entry.coverage === "not-run")).toBe(true)
})

test("automatic fault ranking adds semantic capabilities without repository names", () => {
  const candidates = automaticFaultCandidates({
    ...automaticOptions,
    selector: "tests/mobile-calendar-viewport.spec.ts:20",
  }).map((fault) => fault.kind)

  expect(candidates.slice(0, 6)).toEqual([
    "viewport",
    "reduced-motion",
    "animation-speed",
    "clock-jump",
    "locale",
    "timezone",
  ])
  expect(candidates).toContain("worker-pressure")
  expect(candidates).toContain("network-delay")
  const faults = automaticFaultCandidates(automaticOptions)
  expect(faults.find((fault) => fault.kind === "network-delay")?.pattern)
    .toBe("**/data/items*")
  expect(faults.find((fault) => fault.kind === "startup-event-delay")?.pattern).toBe("**")
  expect(faults.find((fault) => fault.kind === "event-loop-stall")?.pattern).toBe("**")
  expect(automaticScreeningTrialBound(automaticOptions.selector)).toBe(7)
  expect(automaticScreeningTrialBound("tests/mobile-calendar.spec.ts")).toBe(13)
})

test("automatic discovery uses one exploratory probe when no family shows a signal", async () => {
  let executions = 0
  const result = selectAutomaticFault(() => {
    executions += 1
    return Promise.resolve({ durationMs: 1, exitCode: 0, status: "passed" as const })
  }, automaticOptions)

  await expect(result).rejects.toBeInstanceOf(NoAutomaticFaultSignalError)
  expect(executions).toBe(7)
})

test("automatic discovery derives runner coverage from resolved test and scan capabilities", async () => {
  let executions = 0
  const result = selectAutomaticFault(() => {
    executions += 1
    return Promise.resolve({ durationMs: 1, exitCode: 0, status: "passed" as const })
  }, {
    ...automaticOptions,
    capabilities: {
      scan: { clean: true, executions: 4, workers: 2 },
      selectedTestCount: 1,
    },
  })

  let noSignal: NoAutomaticFaultSignalError | undefined
  try {
    await result
  } catch (cause) {
    if (cause instanceof NoAutomaticFaultSignalError) noSignal = cause
  }
  expect(noSignal).toBeDefined()
  expect(executions).toBe(6)
  expect(noSignal?.screenings.find((entry) => entry.fault.kind === "worker-pressure"))
    .toMatchObject({ coverage: "not-applicable", trials: 0 })
  expect(noSignal?.screenings.find((entry) => entry.fault.kind === "shared-state-interference"))
    .toMatchObject({ coverage: "covered-by-scan", trials: 0 })
  expect(automaticScreeningTrialBound(automaticOptions.selector, {
    scan: { clean: true, executions: 4, workers: 2 },
    selectedTestCount: 1,
  })).toBe(6)
  expect(automaticScreeningTrialBound(automaticOptions.selector, {
    scan: { clean: false, executions: 4, workers: 2 },
    selectedTestCount: 1,
  })).toBe(7)
  expect(automaticScreeningTrialBound(automaticOptions.selector, {
    selectedTestCount: 2,
  })).toBe(8)
})

test("automatic discovery does not misclassify runner errors as a clean screen", async () => {
  const result = selectAutomaticFault(() => Promise.resolve({
    durationMs: 1,
    errorReason: "browser process exited",
    exitCode: 1,
    status: "error" as const,
  }), automaticOptions)

  await expect(result).rejects.toThrow("Automatic fault screening encountered runner errors")
})
