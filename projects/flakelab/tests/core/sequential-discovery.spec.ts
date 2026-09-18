import { expect, test } from "@playwright/test"

import { discoverAuthCookieExpiry } from "../../src/discovery/auth-cookie.js"
import {
  evaluateExperiment,
  fisherExactOneSided,
  sequentialConfirmationThreshold,
} from "../../src/discovery/evaluate.js"

const options = {
  concurrency: 2,
  cookieName: "session-id",
  minimumFailureRate: 0.7,
  pattern: "**/api/session",
  seed: 42,
  trials: 4,
}

test("sequential confirmation extends an ambiguous four-pair look to six", async () => {
  let intervention = 0
  const result = await discoverAuthCookieExpiry((trial) => {
    const treated = trial.faults.some((fault) => fault.kind === "auth-cookie-expiry")
    if (treated) intervention += 1
    const failed = treated && intervention !== 1
    return Promise.resolve({
      status: failed ? "failed" as const : "passed" as const,
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "expired-session" } : {}),
    })
  }, options)

  expect(result.triggerResult).toMatchObject({
    confirmed: true,
    failed: 5,
    sequentialDecision: { pairs: 6, verdict: "confirmed" },
    trials: 6,
  })
})

test("sequential confirmation can wait until the eight-pair boundary", async () => {
  let intervention = 0
  const result = await discoverAuthCookieExpiry((trial) => {
    const treated = trial.faults.some((fault) => fault.kind === "auth-cookie-expiry")
    if (treated) intervention += 1
    const failed = treated && intervention > 2
    return Promise.resolve({
      status: failed ? "failed" as const : "passed" as const,
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "expired-session" } : {}),
    })
  }, options)

  expect(result.triggerResult).toMatchObject({
    confirmed: true,
    failed: 6,
    sequentialDecision: { pairs: 8, verdict: "confirmed" },
    trials: 8,
  })
})

test("sequential confirmation rejects a noisy control at the first look", async () => {
  let controls = 0
  let executions = 0
  const result = discoverAuthCookieExpiry((trial) => {
    executions += 1
    const treated = trial.faults.some((fault) => fault.kind === "auth-cookie-expiry")
    if (!treated) controls += 1
    const failed = treated || controls <= 2
    return Promise.resolve({
      status: failed ? "failed" as const : "passed" as const,
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "expired-session" } : {}),
    })
  }, { ...options, concurrency: 1 })

  await expect(result).rejects.toThrow("did not reproduce the failure confidently")
  expect(executions).toBe(8)
})

test("Fisher decision is exact for a perfect four-pair split", () => {
  expect(fisherExactOneSided(4, 4, 0, 4)).toBeCloseTo(1 / 70)
})

test("sequential Fisher boundaries are deterministic and auditable", () => {
  expect([
    sequentialConfirmationThreshold(4, 0),
    sequentialConfirmationThreshold(4, 1),
    sequentialConfirmationThreshold(6, 0),
    sequentialConfirmationThreshold(6, 1),
    sequentialConfirmationThreshold(6, 2),
    sequentialConfirmationThreshold(8, 0),
    sequentialConfirmationThreshold(8, 1),
    sequentialConfirmationThreshold(8, 2),
    sequentialConfirmationThreshold(8, 3),
  ]).toEqual([4, null, 5, 5, null, 6, 6, 7, null])
})

test("aborted experiment batches are never summarized as complete", async () => {
  const controller = new AbortController()
  let executions = 0
  const result = evaluateExperiment(() => {
    executions += 1
    controller.abort()
    return Promise.resolve({ status: "passed" as const, durationMs: 1, exitCode: 0 })
  }, {
    concurrency: 1,
    faults: [],
    minimumFailureRate: 0.7,
    seed: 1,
    signal: controller.signal,
    trials: 4,
  })

  await expect(result).rejects.toThrow("interrupted before its batch completed")
  expect(executions).toBe(1)
})
