import { expect, test } from "@playwright/test"

import { planTrials } from "../../src/core/plan.js"
import { runRequestSchema } from "../../src/domain/schema.js"

const request = runRequestSchema.parse({
  selector: "tests/fixtures/flaky-checkout.spec.ts",
  runs: 4,
  seed: 42,
  artifactDirectory: ".flakelab/runs",
  fault: { kind: "network-delay", pattern: "**/api/checkout", delayMs: 250 },
})

test("trial plans are repeatable and alternate baseline with fault trials", () => {
  const first = planTrials(request)
  const second = planTrials(request)

  expect(second).toEqual(first)
  expect(first.map((trial) => trial.seed)).toEqual([
    42,
    2_654_435_803,
    1_013_904_268,
    3_668_340_029,
  ])
  expect(first.map((trial) => trial.fault?.kind ?? "baseline")).toEqual([
    "baseline",
    "network-delay",
    "baseline",
    "network-delay",
  ])
})
