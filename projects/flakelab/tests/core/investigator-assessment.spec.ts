import { expect, test } from "@playwright/test"

import {
  applyInvestigationAssessment,
  generateValidInvestigationAssessment,
  groundAssessmentInEvidence,
  investigationAssessmentSchema,
  validateExperimentEvidence,
} from "../../src/investigator/assessment.js"
import { RecoverableGenerationError } from "../../src/investigator/generation.js"
import { InvestigationLedger } from "../../src/investigator/ledger.js"

const passingResult = {
  confirmed: false,
  errors: 0,
  failed: 0,
  failureRate: 0,
  failureSignatures: [],
  lowerBound80: 0,
  passed: 4,
  representativeRuns: [],
  trials: 4,
  upperBound80: 0.2911,
}

const failingResult = {
  confirmed: true,
  dominantFailureSignature: "checkout-timeout",
  errors: 0,
  failed: 4,
  failureRate: 1,
  failureSignatures: [{
    failures: 4,
    failureRate: 1,
    lowerBound80: 0.7089,
    signature: "checkout-timeout",
    upperBound80: 1,
  }],
  lowerBound80: 0.7089,
  passed: 0,
  representativeRuns: [],
  trials: 4,
  upperBound80: 1,
}

const validAssessment = investigationAssessmentSchema.parse({
  assessments: [
    {
      explanation: "Network delay reliably reproduced the checkout timeout",
      hypothesisId: "H1",
      status: "confirmed",
    },
    {
      explanation: "Request failure did not reproduce the checkout timeout",
      hypothesisId: "H2",
      status: "rejected",
    },
  ],
  conclusion: "Network delay confirms the checkout response timing race mechanism",
  conclusionHypothesisId: "H1",
})

function investigationState() {
  const ledger = new InvestigationLedger()
  const timing = ledger.propose(
    "Checkout has a response timing race",
    "Network delay will reproduce the checkout timeout",
  )
  const status = ledger.propose(
    "Checkout mishandles failed requests",
    "A failed request will expose missing error handling",
  )
  const evidence = [
    ledger.addExperiment(timing.id, { kind: "baseline" }, passingResult),
    ledger.addExperiment(status.id, { kind: "request-failure", statusCode: 503 }, passingResult),
    ledger.addExperiment(timing.id, { delayMs: 125, kind: "network-delay" }, failingResult),
  ]
  return { evidence, hypotheses: [timing, status], ledger }
}

test("FlakeLab binds evidence IDs instead of trusting the model to do it", () => {
  const state = investigationState()
  applyInvestigationAssessment(state, {
    assessments: [
      {
        explanation: "Request failure did not reproduce the checkout timeout",
        hypothesisId: "H2",
        status: "rejected",
      },
      {
        explanation: "Network delay reliably reproduced the checkout timeout",
        hypothesisId: "H1",
        status: "confirmed",
      },
    ],
    conclusion: "Network delay confirms the checkout response timing race mechanism",
    conclusionHypothesisId: "H1",
  })

  const report = state.ledger.buildReport("tests/checkout.spec.ts", "test-model", [
    "tests/checkout.spec.ts",
  ], { estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 })
  expect(report.hypotheses[0].evidenceExperimentIds).toEqual(["E3"])
  expect(report.hypotheses[1].evidenceExperimentIds).toEqual(["E2"])
  expect(report.conclusionEvidenceIds).toEqual(["E3"])
})

test("measured evidence corrects a model conclusion pointed at the rejected hypothesis", () => {
  const state = investigationState()
  const grounded = groundAssessmentInEvidence(state, {
    assessments: [
      { explanation: "Incorrect model status", hypothesisId: "H1", status: "rejected" },
      { explanation: "Incorrect model status", hypothesisId: "H2", status: "confirmed" },
    ],
    conclusion: "The model selected the unsupported failed-request hypothesis",
    conclusionHypothesisId: "H2",
  })

  expect(grounded.conclusionHypothesisId).toBe("H1")
  expect(grounded.assessments).toEqual([
    expect.objectContaining({ hypothesisId: "H1", status: "confirmed" }),
    expect.objectContaining({ hypothesisId: "H2", status: "rejected" }),
  ])
  applyInvestigationAssessment(state, grounded)
  expect(state.ledger.buildReport(
    "tests/checkout.spec.ts",
    "test-model",
    ["tests/checkout.spec.ts"],
    { estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 },
  ).conclusionHypothesisId).toBe("H1")
})

test("confirmed evidence constructs the assessment without model adjudication", () => {
  const state = investigationState()
  const grounded = groundAssessmentInEvidence(state)

  expect(grounded.conclusionHypothesisId).toBe("H1")
  expect(grounded.assessments).toEqual([
    expect.objectContaining({ hypothesisId: "H1", status: "confirmed" }),
    expect.objectContaining({ hypothesisId: "H2", status: "rejected" }),
  ])
  applyInvestigationAssessment(state, grounded)
  expect(state.ledger.buildReport(
    "tests/checkout.spec.ts",
    "test-model",
    ["tests/checkout.spec.ts"],
    { estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 },
  ).conclusionEvidenceIds).toEqual(["E3"])
})

test("discovery evidence anchors one primary hypothesis when another intervention is causal", () => {
  const state = investigationState()
  state.evidence[1].result = failingResult

  const grounded = groundAssessmentInEvidence(
    state,
    undefined,
    { delayMs: 125, kind: "network-delay" },
  )

  expect(grounded.conclusionHypothesisId).toBe("H1")
  expect(grounded.assessments).toEqual([
    expect.objectContaining({ hypothesisId: "H1", status: "confirmed" }),
    expect.objectContaining({ hypothesisId: "H2", status: "corroborating" }),
  ])
  applyInvestigationAssessment(state, grounded)
  const report = state.ledger.buildReport(
    "tests/checkout.spec.ts",
    "test-model",
    ["tests/checkout.spec.ts"],
    { estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 },
  )
  expect(report.conclusionHypothesisId).toBe("H1")
  expect(report.hypotheses[1]).toEqual(expect.objectContaining({
    evidenceExperimentIds: ["E2"],
    status: "corroborating",
  }))
})

test("paired discovery evidence remains causal when a later baseline is noisy", () => {
  const state = investigationState()
  state.evidence[0].result = {
    ...passingResult,
    failed: 2,
    failureRate: 0.5,
    lowerBound80: 0.2302,
    passed: 2,
    upperBound80: 0.7698,
  }
  state.evidence[2].result = {
    ...failingResult,
    causalEffect: {
      controlFailures: 0,
      controlRate: 0,
      controlUpperBound80: 0.2911,
      failureRateIncrease: 1,
      signature: "checkout-timeout",
      treatmentFailures: 4,
      treatmentLowerBound80: 0.7089,
      treatmentRate: 1,
    },
  }

  const grounded = groundAssessmentInEvidence(
    state,
    undefined,
    { delayMs: 125, kind: "network-delay" },
  )

  expect(grounded.conclusionHypothesisId).toBe("H1")
  expect(grounded.assessments).toEqual([
    expect.objectContaining({ hypothesisId: "H1", status: "confirmed" }),
    expect.objectContaining({ hypothesisId: "H2", status: "rejected" }),
  ])
  applyInvestigationAssessment(state, grounded)
  expect(state.ledger.buildReport(
    "tests/checkout.spec.ts",
    "test-model",
    ["tests/checkout.spec.ts"],
    { estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 },
  ).conclusionEvidenceIds).toEqual(["E3"])
})

test("errored experiments stop before model assessment", () => {
  const state = investigationState()
  state.evidence[2].result = {
    ...passingResult,
    errors: 4,
    passed: 0,
  }

  expect(() => validateExperimentEvidence(state.evidence)).toThrow(
    /Experiment E3 produced 4 runner error\(s\) and is inconclusive/u,
  )
})

test("schema-invalid assessment JSON receives one bounded correction attempt", async () => {
  const prompts: string[] = []
  const temperatures: number[] = []

  const result = await generateValidInvestigationAssessment({
    generate: (prompt, temperature) => {
      prompts.push(prompt)
      temperatures.push(temperature)
      if (prompts.length === 1) {
        return Promise.reject(new RecoverableGenerationError(
          "missing properties: conclusionHypothesisId, conclusion",
          '{"assessments":[]}',
          { inputTokens: 10, outputTokens: 5 },
        ))
      }
      return Promise.resolve({
        output: validAssessment,
        usage: { inputTokens: 12, outputTokens: 6 },
      })
    },
    initialPrompt: "Assess the causal evidence.",
    maxAttempts: 2,
  })

  expect(result.assessment).toEqual(validAssessment)
  expect(result.attempts).toEqual([
    { inputTokens: 10, outputTokens: 5 },
    { inputTokens: 12, outputTokens: 6 },
  ])
  expect(temperatures).toEqual([0.2, 0])
  expect(prompts[1]).toContain("conclusionHypothesisId")
  expect(prompts[1]).toContain('{"assessments":[]}')
})

test("assessment schema correction respects its attempt budget", async () => {
  await expect(generateValidInvestigationAssessment({
    generate: () => Promise.reject(new RecoverableGenerationError(
      "missing properties: conclusionHypothesisId, conclusion",
      '{"assessments":[]}',
      { inputTokens: 10, outputTokens: 5 },
    )),
    initialPrompt: "Assess the causal evidence.",
    maxAttempts: 1,
  })).rejects.toThrow(/missing properties: conclusionHypothesisId, conclusion/u)
})
