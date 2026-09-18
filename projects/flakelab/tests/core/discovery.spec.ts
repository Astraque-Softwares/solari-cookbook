import { expect, test } from "@playwright/test"

import {
  buildDiscoveredReproducer,
  discoveryFailureDetail,
} from "../../src/commands/discover.js"
import { discoverAuthCookieExpiry } from "../../src/discovery/auth-cookie.js"
import { discoverEventLoopStall } from "../../src/discovery/event-loop.js"
import { evaluateExperiment } from "../../src/discovery/evaluate.js"
import {
  discoverNetworkDelay,
  discoverResponseDuplication,
  discoverResponseReordering,
  discoverResponseTruncation,
  minimizeItems,
} from "../../src/discovery/minimize.js"
import { discoverResourceLoadingDelay } from "../../src/discovery/resource-loading.js"
import { discoverStartupEventDelay } from "../../src/discovery/startup-event.js"
import { discoverStorageStateDelay } from "../../src/discovery/storage-state.js"

test("discovery timeout reports incomplete planned work instead of denying evidence", () => {
  expect(discoveryFailureDetail(true, 72, 96)).toBe(
    "incomplete · 72 of 96 planned trials",
  )
  expect(discoveryFailureDetail(false, 8, 96)).toBe("no confirmed trigger · 8 trials")
})

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
  }, { concurrency: 1, faults: [], minimumFailureRate: 0.7, seed: 1, trials: 4 })

  expect(result.failureRate).toBe(0.25)
  expect(result.confirmed).toBe(false)
})

test("experiment summaries retain the actionable runner error", async () => {
  const result = await evaluateExperiment(() => Promise.resolve({
    status: "error",
    durationMs: 1,
    exitCode: 1,
    failureReason: "project-level event-loop-stall fault did not match the document",
    failureSignature: "unmatched-fault",
  }), { concurrency: 2, faults: [], minimumFailureRate: 0.7, seed: 1, trials: 4 })

  expect(result).toMatchObject({
    dominantErrorReason: "project-level event-loop-stall fault did not match the document",
    errors: 4,
  })
})

test("causal discovery can amplify an existing matching failure signature", async () => {
  let controlRuns = 0
  const result = await discoverNetworkDelay((trial) => {
    const treated = trial.faults.some((fault) => fault.kind === "network-delay")
    if (!treated) {
      controlRuns += 1
    }
    const failed = treated || controlRuns === 1
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "checkout-timeout" } : {}),
    })
  }, {
    concurrency: 1,
    maximumDelayMs: 2,
    minimumFailureRate: 0.7,
    pattern: "**/api/checkout",
    seed: 42,
    trials: 4,
  })

  expect(result.baseline.failureRate).toBeCloseTo(1 / 6)
  expect(result.trigger.delayMs).toBe(2)
  expect(result.triggerResult).toMatchObject({
    confirmed: true,
    causalEffect: {
      controlFailures: 1,
      signature: "checkout-timeout",
      treatmentFailures: 6,
    },
    sequentialDecision: { pairs: 6, verdict: "confirmed" },
  })
})

test("causal discovery interleaves paired controls and interventions", async () => {
  const trialIds: string[] = []
  await discoverAuthCookieExpiry((trial) => {
    trialIds.push(trial.trialId)
    const failed = trial.faults.some((fault) => fault.kind === "auth-cookie-expiry")
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "expired-session" } : {}),
    })
  }, {
    concurrency: 1,
    cookieName: "session-id",
    minimumFailureRate: 0.7,
    pattern: "**/api/session",
    seed: 42,
    trials: 4,
  })

  expect(trialIds.slice(0, 8)).toEqual([
    "confirm-1-pair-1-control",
    "confirm-1-pair-1-intervention",
    "confirm-1-pair-2-intervention",
    "confirm-1-pair-2-control",
    "confirm-1-pair-3-control",
    "confirm-1-pair-3-intervention",
    "confirm-1-pair-4-intervention",
    "confirm-1-pair-4-control",
  ])
})

test("causal discovery rejects a matching failure rate in the control", async () => {
  await expect(discoverNetworkDelay(() => Promise.resolve({
    status: "failed",
    durationMs: 1,
    exitCode: 1,
    failureSignature: "checkout-timeout",
  }), {
    concurrency: 1,
    maximumDelayMs: 2,
    minimumFailureRate: 0.7,
    pattern: "**/api/checkout",
    seed: 42,
    trials: 4,
  })).rejects.toThrow("Maximum network delay did not reproduce the failure confidently")
})

test("discovered reproducers retain the causal confirmation trial count", () => {
  const reproducer = buildDiscoveredReproducer(
    "tests/startup.spec.ts",
    42,
    0.7,
    {
      kind: "resource-loading-delay",
      delayMs: 429,
      pattern: "**/assets/*",
      resourceType: "script",
    },
    {
      confirmed: true,
      dominantFailureSignature: "startup-deadline",
      errors: 0,
      failed: 12,
      failureRate: 1,
      failureSignatures: [{
        failures: 12,
        failureRate: 1,
        lowerBound80: 0.88,
        signature: "startup-deadline",
        upperBound80: 1,
      }],
      lowerBound80: 0.88,
      passed: 0,
      representativeRuns: [],
      trials: 12,
      upperBound80: 1,
    },
  )

  expect(reproducer.trials).toBe(12)
  expect(reproducer.expectedFailure.signature).toBe("startup-deadline")
})

test("network delay discovery ships the robust configured trigger", async () => {
  const result = await discoverNetworkDelay((trial) => {
    const delay = trial.faults.find((fault) => fault.kind === "network-delay")
    const delayMs = delay?.kind === "network-delay" ? delay.delayMs : 0
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

  expect(result.trigger.delayMs).toBe(250)
  expect(result.triggerResult.confirmed).toBe(true)
  expect(result.triggerResult.trials).toBe(4)
  expect(result.experiments).toHaveLength(1)
})

test("network delay discovery does not spend executions on a fragile minimum", async () => {
  const attempts = new Map<number, number>()
  const result = await discoverNetworkDelay((trial) => {
    const delay = trial.faults.find((fault) => fault.kind === "network-delay")
    const delayMs = delay?.kind === "network-delay" ? delay.delayMs : 0
    const attempt = attempts.get(delayMs) ?? 0
    attempts.set(delayMs, attempt + 1)
    const unstableBoundary = delayMs === 100 && attempt < 4
    const failed = delayMs > 100 || unstableBoundary
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "checkout-timeout" } : {}),
    })
  }, {
    concurrency: 1,
    maximumDelayMs: 250,
    minimumFailureRate: 0.7,
    pattern: "**/api/checkout",
    seed: 42,
    trials: 4,
  })

  expect(result.trigger.delayMs).toBe(250)
  expect(result.triggerResult.confirmed).toBe(true)
  expect([...attempts.keys()].sort((left, right) => left - right)).toEqual([0, 250])
})

test("response truncation discovery ships the robust configured removal", async () => {
  const result = await discoverResponseTruncation((trial) => {
    const truncation = trial.faults.find((fault) => fault.kind === "response-truncation")
    const removeBytes = truncation?.kind === "response-truncation"
      ? truncation.removeBytes
      : 0
    const failed = removeBytes >= 7
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "partial-json" } : {}),
    })
  }, {
    concurrency: 2,
    maximumRemoveBytes: 64,
    minimumFailureRate: 0.7,
    pattern: "**/api/checkout",
    seed: 42,
    trials: 4,
  })

  expect(result.trigger.removeBytes).toBe(64)
  expect(result.triggerResult.confirmed).toBe(true)
  expect(result.triggerResult.trials).toBe(4)
})

test("response duplication discovery ships the robust configured byte count", async () => {
  const result = await discoverResponseDuplication((trial) => {
    const duplication = trial.faults.find((fault) => fault.kind === "response-duplication")
    const duplicateBytes = duplication?.kind === "response-duplication"
      ? duplication.duplicateBytes
      : 0
    const failed = duplicateBytes >= 7
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "duplicate-json" } : {}),
    })
  }, {
    concurrency: 2,
    maximumDuplicateBytes: 64,
    minimumFailureRate: 0.7,
    pattern: "**/api/checkout",
    seed: 42,
    trials: 4,
  })

  expect(result.trigger.duplicateBytes).toBe(64)
  expect(result.triggerResult.confirmed).toBe(true)
  expect(result.triggerResult.trials).toBe(4)
})

test("response reordering discovery ships the robust configured hold", async () => {
  const result = await discoverResponseReordering((trial) => {
    const reordering = trial.faults.find((fault) => fault.kind === "response-reordering")
    const holdMs = reordering?.kind === "response-reordering" ? reordering.holdMs : 0
    const failed = holdMs >= 30
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "stale-response" } : {}),
    })
  }, {
    concurrency: 2,
    maximumHoldMs: 100,
    minimumFailureRate: 0.7,
    pattern: "**/api/search*",
    seed: 42,
    trials: 4,
  })

  expect(result.trigger.holdMs).toBe(100)
  expect(result.triggerResult.confirmed).toBe(true)
  expect(result.triggerResult.trials).toBe(4)
})

test("resource loading discovery ships the robust configured script delay", async () => {
  const result = await discoverResourceLoadingDelay((trial) => {
    const resourceDelay = trial.faults.find((fault) => fault.kind === "resource-loading-delay")
    const delayMs = resourceDelay?.kind === "resource-loading-delay" ? resourceDelay.delayMs : 0
    const failed = delayMs >= 75
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "startup-deadline" } : {}),
    })
  }, {
    concurrency: 2,
    maximumDelayMs: 150,
    minimumFailureRate: 0.7,
    pattern: "**/assets/*",
    resourceType: "script",
    seed: 42,
    trials: 4,
  })

  expect(result.minimumDelayMs).toBe(150)
  expect(result.trigger).toMatchObject({ delayMs: 150, resourceType: "script" })
  expect(result.triggerResult.confirmed).toBe(true)
  expect(result.triggerResult.trials).toBe(4)
})

test("startup event discovery ships the robust configured trigger", async () => {
  const result = await discoverStartupEventDelay((trial) => {
    const startupDelay = trial.faults.find((fault) => fault.kind === "startup-event-delay")
    const delayMs = startupDelay?.kind === "startup-event-delay" ? startupDelay.delayMs : 0
    const failed = delayMs >= 75
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "hydration-deadline" } : {}),
    })
  }, {
    concurrency: 2,
    event: "dom-content-loaded",
    maximumDelayMs: 150,
    minimumFailureRate: 0.7,
    pattern: "**/hydration",
    seed: 42,
    trials: 4,
  })

  expect(result.minimumDelayMs).toBe(150)
  expect(result.trigger).toMatchObject({
    delayMs: 150,
    event: "dom-content-loaded",
  })
  expect(result.triggerResult.confirmed).toBe(true)
  expect(result.triggerResult.trials).toBe(4)
})

test("event-loop discovery ships the robust configured stall", async () => {
  const result = await discoverEventLoopStall((trial) => {
    const stall = trial.faults.find((fault) => fault.kind === "event-loop-stall")
    const durationMs = stall?.kind === "event-loop-stall" ? stall.durationMs : 0
    const failed = durationMs >= 150
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "main-thread-deadline" } : {}),
    })
  }, {
    concurrency: 2,
    maximumDurationMs: 300,
    minimumFailureRate: 0.7,
    pattern: "**/event-loop",
    seed: 42,
    startAfterMs: 0,
    trials: 4,
  })

  expect(result.minimumDurationMs).toBe(300)
  expect(result.trigger).toMatchObject({ durationMs: 300, startAfterMs: 0 })
  expect(result.triggerResult.confirmed).toBe(true)
  expect(result.triggerResult.trials).toBe(4)
})

test("auth-cookie discovery confirms a value-free expired-session trigger", async () => {
  const result = await discoverAuthCookieExpiry((trial) => {
    const expired = trial.faults.some((fault) => fault.kind === "auth-cookie-expiry")
    return Promise.resolve({
      status: expired ? "failed" : "passed",
      durationMs: 1,
      exitCode: expired ? 1 : 0,
      ...(expired ? { failureSignature: "expired-session" } : {}),
    })
  }, {
    concurrency: 2,
    cookieName: "session-id",
    minimumFailureRate: 0.7,
    pattern: "**/api/session",
    seed: 42,
    trials: 4,
  })

  expect(result.trigger).toEqual({
    kind: "auth-cookie-expiry",
    cookieName: "session-id",
    pattern: "**/api/session",
  })
  expect(result.triggerResult.confirmed).toBe(true)
  expect(result.triggerResult.trials).toBe(4)
})

test("storage-state discovery ships the robust configured trigger", async () => {
  const result = await discoverStorageStateDelay((trial) => {
    const delay = trial.faults.find((fault) => fault.kind === "storage-state-delay")
    const delayMs = delay?.kind === "storage-state-delay" ? delay.delayMs : 0
    const failed = delayMs >= 100
    return Promise.resolve({
      status: failed ? "failed" : "passed",
      durationMs: 1,
      exitCode: failed ? 1 : 0,
      ...(failed ? { failureSignature: "storage-not-ready" } : {}),
    })
  }, {
    concurrency: 2,
    key: "auth-token",
    maximumDelayMs: 250,
    minimumFailureRate: 0.7,
    pattern: "**/app",
    seed: 42,
    storage: "local-storage",
    trials: 4,
  })

  expect(result.minimumDelayMs).toBe(250)
  expect(result.trigger).toMatchObject({
    delayMs: 250,
    key: "auth-token",
    storage: "local-storage",
  })
  expect(result.triggerResult.confirmed).toBe(true)
  expect(result.triggerResult.trials).toBe(4)
})

test("combination minimization removes irrelevant conditions", async () => {
  const minimal = await minimizeItems(["delay", "locale", "viewport"], (candidate) =>
    Promise.resolve(candidate.includes("delay")))

  expect(minimal).toEqual(["delay"])
})
