import { expect, test } from "@playwright/test"

import { InvestigationBudget } from "../../src/investigator/budget.js"
import { InvestigationLedger } from "../../src/investigator/ledger.js"

const passingResult = {
  confirmed: false,
  errors: 0,
  failed: 0,
  failureRate: 0,
  lowerBound80: 0,
  passed: 4,
  trials: 4,
}

const failingResult = {
  confirmed: true,
  dominantFailureSignature: "checkout-timeout",
  errors: 0,
  failed: 4,
  failureRate: 1,
  lowerBound80: 0.7089,
  passed: 0,
  trials: 4,
}

test("ledger accepts only an evidence-grounded causal conclusion", () => {
  const ledger = new InvestigationLedger()
  const timing = ledger.propose(
    "Checkout has a timing race",
    "Network delay will cause the assertion to fail",
  )
  const status = ledger.propose(
    "Checkout mishandles HTTP status",
    "An injected 503 response will cause the assertion to fail",
  )
  ledger.addExperiment(timing.id, { kind: "baseline" }, passingResult)
  const statusEvidence = ledger.addExperiment(
    status.id,
    { kind: "request-failure", statusCode: 503 },
    passingResult,
  )
  const timingEvidence = ledger.addExperiment(
    timing.id,
    { kind: "network-delay", delayMs: 125 },
    failingResult,
  )

  ledger.assess(timing.id, "confirmed", [timingEvidence.id], "Delay changed failure rate")
  ledger.assess(status.id, "rejected", [statusEvidence.id], "HTTP status did not cause failure")
  ledger.conclude(
    timing.id,
    "Network delay confirms that checkout has a timing race",
    [timingEvidence.id],
  )

  const report = ledger.buildReport("tests/checkout.spec.ts", "test-model", {
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.001,
  })
  expect(report.hypotheses).toHaveLength(2)
  expect(report.conclusionHypothesisId).toBe("H1")
  expect(report.conclusionEvidenceIds).toEqual(["E3"])
})

test("ledger rejects confirmation without a causal intervention", () => {
  const ledger = new InvestigationLedger()
  const hypothesis = ledger.propose(
    "Checkout has a timing race",
    "Network delay will cause the assertion to fail",
  )
  const baseline = ledger.addExperiment(hypothesis.id, { kind: "baseline" }, passingResult)

  expect(() => ledger.assess(
    hypothesis.id,
    "confirmed",
    [baseline.id],
    "Baseline evidence is not causal",
  )).toThrow(/Confirmation requires/u)
})

test("experiment budget prevents unbounded model-selected work", () => {
  const budget = new InvestigationBudget({
    maxCostUsd: 0.25,
    maxExperiments: 1,
    maxSeconds: 60,
    maxTrials: 4,
  })
  budget.reserveExperiment(4)

  expect(() => {
    budget.reserveExperiment(4)
  }).toThrow(/experiment budget exhausted/u)
})
