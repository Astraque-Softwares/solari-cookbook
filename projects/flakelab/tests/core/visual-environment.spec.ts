import { expect, test } from "@playwright/test"

import {
  discoverAnimationSpeed,
  discoverReducedMotion,
  discoverViewport,
} from "../../src/discovery/visual-environment.js"
import { browserContextFaultOptions } from "../../src/faults/browser-context.js"
import type { TrialExecutor } from "../../src/runner/playwright-executor.js"

const reproducingExecutor: TrialExecutor = (trial) => Promise.resolve({
  status: trial.faults.length === 0 ? "passed" : "failed",
  durationMs: 1,
  exitCode: trial.faults.length === 0 ? 0 : 1,
  ...(trial.faults.length === 0 ? {} : { failureSignature: "visual-failure" }),
})

const options = {
  concurrency: 2,
  minimumFailureRate: 0.5,
  pattern: "**/visual-environment",
  seed: 11,
  trials: 2,
}

test("visual discovery confirms each fault in an independent batch", async () => {
  const animation = await discoverAnimationSpeed(reproducingExecutor, { ...options, rate: 5 })
  const motion = await discoverReducedMotion(reproducingExecutor, options)
  const viewport = await discoverViewport(reproducingExecutor, {
    ...options,
    height: 667,
    width: 375,
  })

  expect(animation.trigger).toMatchObject({ kind: "animation-speed", rate: 5 })
  expect(motion.trigger).toMatchObject({ kind: "reduced-motion" })
  expect(viewport.trigger).toMatchObject({ kind: "viewport", width: 375, height: 667 })
  expect([animation, motion, viewport].map((result) => result.triggerResult.trials))
    .toEqual([4, 4, 4])
})

test("browser context options preserve only native context controls", () => {
  expect(browserContextFaultOptions([
    { kind: "viewport", pattern: "**/app", width: 375, height: 667 },
    { kind: "reduced-motion", pattern: "**/app" },
    { kind: "animation-speed", pattern: "**/app", rate: 5 },
  ])).toEqual({
    reducedMotion: "reduce",
    viewport: { height: 667, width: 375 },
  })
})
