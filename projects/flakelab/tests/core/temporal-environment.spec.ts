import { expect, test } from "@playwright/test"

import { browserContextFaultOptions } from "../../src/faults/browser-context.js"
import {
  discoverClockJump,
  discoverLocale,
  discoverTimezone,
} from "../../src/discovery/temporal-environment.js"
import type { TrialExecutor } from "../../src/runner/playwright-executor.js"

const reproducingExecutor: TrialExecutor = (trial) => Promise.resolve({
  status: trial.faults.length === 0 ? "passed" : "failed",
  durationMs: 1,
  exitCode: trial.faults.length === 0 ? 0 : 1,
  ...(trial.faults.length === 0 ? {} : { failureSignature: "temporal-failure" }),
})

const options = {
  concurrency: 2,
  minimumFailureRate: 0.5,
  pattern: "**/temporal",
  seed: 7,
  trials: 2,
}

test("temporal discovery confirms each fault in an independent batch", async () => {
  const clock = await discoverClockJump(reproducingExecutor, {
    ...options,
    jumpAfterMs: 25,
    offsetMs: 3_600_000,
  })
  const locale = await discoverLocale(reproducingExecutor, { ...options, locale: "fr-FR" })
  const timezone = await discoverTimezone(reproducingExecutor, {
    ...options,
    timezoneId: "America/New_York",
  })

  expect(clock.trigger).toMatchObject({ kind: "clock-jump", offsetMs: 3_600_000 })
  expect(locale.trigger).toMatchObject({ kind: "locale", locale: "fr-FR" })
  expect(timezone.trigger).toMatchObject({ kind: "timezone", timezoneId: "America/New_York" })
  expect([clock, locale, timezone].map((result) => result.triggerResult.trials))
    .toEqual([4, 4, 4])
})

test("browser context options contain no unrelated fault metadata", () => {
  expect(browserContextFaultOptions([
    { kind: "locale", pattern: "**/temporal", locale: "fr-FR" },
    { kind: "timezone", pattern: "**/temporal", timezoneId: "America/New_York" },
  ])).toEqual({ locale: "fr-FR", timezoneId: "America/New_York" })
})
