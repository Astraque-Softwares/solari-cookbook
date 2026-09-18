import { expect, test } from "@playwright/test"

import {
  discoverSharedStateInterference,
  discoverWorkerPressure,
} from "../../src/discovery/runner-environment.js"
import { runnerExecutionControls } from "../../src/runner/execution-fault.js"
import type { TrialExecutor } from "../../src/runner/playwright-executor.js"
import { createPlaywrightExecutor } from "../../src/runner/playwright-executor.js"

const options = {
  concurrency: 2,
  minimumFailureRate: 0.7,
  pattern: "tests/checkout.spec.ts",
  seed: 31,
  trials: 4,
}

test("runner controls are bounded and contain no unrelated browser metadata", () => {
  expect(runnerExecutionControls([])).toEqual({
    arguments: ["--workers=1"],
    environment: {},
  })
  expect(runnerExecutionControls([{
    kind: "worker-pressure",
    pattern: "tests/checkout.spec.ts",
    workers: 3,
  }])).toEqual({
    arguments: ["--workers=3", "--fully-parallel"],
    environment: { FLAKELAB_WORKER_PRESSURE_ACTIVE: "1" },
  })
  expect(runnerExecutionControls([{
    copies: 2,
    kind: "shared-state-interference",
    pattern: "tests/checkout.spec.ts",
  }])).toEqual({
    arguments: ["--workers=2", "--repeat-each=2", "--fully-parallel"],
    environment: { FLAKELAB_SHARED_STATE_ACTIVE: "1" },
  })
})

test("runner discovery confirms the robust configured pressure", async () => {
  const execute: TrialExecutor = (trial) => {
    const fault = trial.faults[0]
    const fails = fault?.kind === "worker-pressure"
      ? fault.workers >= 3
      : fault?.kind === "shared-state-interference" && fault.copies >= 2
    return Promise.resolve({
      durationMs: 1,
      exitCode: fails ? 1 : 0,
      ...(fails ? { failureReason: "shared account collision", failureSignature: "collision" } : {}),
      status: fails ? "failed" : "passed",
    })
  }
  const workers = await discoverWorkerPressure(execute, { ...options, maximumWorkers: 4 })
  const shared = await discoverSharedStateInterference(execute, {
    ...options,
    maximumCopies: 4,
  })

  expect(workers.trigger).toMatchObject({ kind: "worker-pressure", workers: 4 })
  expect(shared.trigger).toMatchObject({ kind: "shared-state-interference", copies: 4 })
  expect([workers.triggerResult.trials, shared.triggerResult.trials]).toEqual([4, 4])
})

test("project runner exposes worker and repeated shared-state collisions", async () => {
  test.slow()
  const workers = createPlaywrightExecutor(
    process.cwd(),
    "tests/fixtures/worker-pressure.spec.ts",
  )
  const shared = createPlaywrightExecutor(
    process.cwd(),
    "tests/fixtures/shared-state.spec.ts",
  )
  const workerBaseline = await workers({
    faults: [], index: 0, seed: 41, trialId: "worker-control",
  })
  const workerFault = await workers({
    faults: [{
      kind: "worker-pressure",
      pattern: "tests/fixtures/worker-pressure.spec.ts",
      workers: 2,
    }],
    index: 1,
    seed: 42,
    trialId: "worker-pressure",
  })
  const sharedFault = await shared({
    faults: [{
      copies: 2,
      kind: "shared-state-interference",
      pattern: "tests/fixtures/shared-state.spec.ts",
    }],
    index: 2,
    seed: 43,
    trialId: "shared-state",
  })

  expect(workerBaseline.status).toBe("passed")
  expect(workerFault.failureReason).toContain("shared account")
  expect(sharedFault.failureReason).toContain("shared account")
})
