import { expect, test } from "@playwright/test"

import {
  collectInvestigationResults,
  type RequiredExperimentEvidence,
} from "../../src/investigator/agent.js"
import { investigationPlanSchema } from "../../src/investigator/planning.js"
import type { ExperimentCondition } from "../../src/investigator/schema.js"

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

const confirmedResult = {
  confirmed: true,
  dominantFailureSignature: "reduced-motion-title",
  errors: 0,
  failed: 12,
  failureRate: 1,
  failureSignatures: [{
    failures: 12,
    failureRate: 1,
    lowerBound80: 0.8796,
    signature: "reduced-motion-title",
    upperBound80: 1,
  }],
  lowerBound80: 0.8796,
  passed: 0,
  representativeRuns: [],
  trials: 12,
  upperBound80: 1,
}

test("investigation reuses the confirmed discovery result without rerunning its fault", async () => {
  const plan = investigationPlanSchema.parse({
    hypotheses: [
      {
        prediction: "Reduced motion changes the rendered account title",
        statement: "The account title depends on motion preferences",
      },
      {
        prediction: "Request failure changes the rendered account title",
        statement: "The account title depends on a successful request",
      },
    ],
    experiments: [
      { condition: { kind: "baseline" }, hypothesisIndex: 0 },
      { condition: { kind: "reduced-motion" }, hypothesisIndex: 0 },
      { condition: { kind: "request-failure", statusCode: 503 }, hypothesisIndex: 1 },
    ],
  })
  const requiredEvidence: RequiredExperimentEvidence = {
    condition: { kind: "reduced-motion" },
    result: confirmedResult,
  }
  const evaluated: ExperimentCondition[] = []

  const results = await collectInvestigationResults(
    plan,
    requiredEvidence,
    (condition) => {
      evaluated.push(condition)
      return Promise.resolve(passingResult)
    },
  )

  expect(results).toEqual([passingResult, confirmedResult, passingResult])
  expect(evaluated).toEqual([
    { kind: "baseline" },
    { kind: "request-failure", statusCode: 503 },
  ])
})
