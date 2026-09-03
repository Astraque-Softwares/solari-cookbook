import { expect, test } from "@playwright/test"

import { evaluateExperiment } from "../../src/discovery/evaluate.js"
import { discoverNetworkDelay, minimizeItems } from "../../src/discovery/minimize.js"

test("confidence evaluation rejects insufficient evidence", async () => {
  let index = 0
  const result = await evaluateExperiment(() => {
    index += 1
    return Promise.resolve({
      status: index === 1 ? "failed" : "passed",
      durationMs: 1,
      exitCode: index === 1 ? 1 : 0,
      ...(index === 1 ? { failureSignature: "timeout" } : {}),
    })
  }, { concurrency: 1, minimumFailureRate: 0.7, seed: 1, trials: 4 })

  expect(result.failureRate).toBe(0.25)
  expect(result.confirmed).toBe(false)
})

test("network delay discovery finds the smallest confirmed integer delay", async () => {
  const result = await discoverNetworkDelay((trial) => {
    const delayMs = trial.fault?.kind === "network-delay" ? trial.fault.delayMs : 0
    const failed = delayMs >= 100
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "checkout-timeout" } : {}),
    })
  }, {
    concurrency: 4,
    maximumDelayMs: 250,
    minimumFailureRate: 0.7,
    pattern: "**/api/checkout",
    seed: 42,
    trials: 4,
  })

  expect(result.trigger.delayMs).toBe(100)
  expect(result.triggerResult.confirmed).toBe(true)
})

test("combination minimization removes irrelevant conditions", async () => {
  const minimal = await minimizeItems(["delay", "locale", "viewport"], (candidate) =>
    Promise.resolve(candidate.includes("delay")))

  expect(minimal).toEqual(["delay"])
})
