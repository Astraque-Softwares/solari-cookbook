import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { diagnose, resumeDiagnosis } from "../../src/commands/diagnose.js"
import type { DiagnoseOptions } from "../../src/commands/options.js"
import { buildDiagnosisRecommendation } from "../../src/diagnosis/recommendation.js"
import { diagnosisArtifactSchema } from "../../src/diagnosis/schema.js"

function options(overrides: Partial<DiagnoseOptions> = {}): DiagnoseOptions {
  return {
    artifacts: ".flakelab/runs",
    concurrency: "1",
    discover: false,
    evidence: "flakelab.investigation.json",
    html: "flakelab.report.html",
    investigate: false,
    "max-cost": "0.25",
    "max-delay": "250",
    "max-experiments": "3",
    "max-seconds": "90",
    "max-steps": "3",
    "max-trials": "12",
    "min-rate": "0.7",
    model: "test-model",
    open: false,
    patch: "candidate.diff",
    pattern: "**/api/checkout",
    proof: "flakelab.proof.json",
    "prompt-credentials": false,
    repair: false,
    reproducer: "flakelab.repro.yaml",
    runs: "4",
    seed: "1",
    source: [],
    trials: "4",
    ...overrides,
  }
}

test("adaptive recommendations keep the cheapest useful next step explicit", () => {
  const local = buildDiagnosisRecommendation({
    elapsedMilliseconds: 4_000,
    observedRuns: 4,
    stage: "observed",
    status: "no-failure-observed",
    target: "tests/checkout.spec.ts",
    values: options(),
  })
  expect(local).toMatchObject({
    credentials: [],
    expectedDuration: "up to 2 minute(s)",
    plannedTrials: 7,
    solariCostEstimateUsd: 0,
  })
  expect(local.command).toContain("--discover")

  const mixed = buildDiagnosisRecommendation({
    elapsedMilliseconds: 4_000,
    observedRuns: 4,
    stage: "observed",
    status: "mixed-outcomes",
    target: "tests/checkout.spec.ts",
    values: options(),
  })
  expect(mixed).toMatchObject({
    command: "flakelab diagnose \"tests/checkout.spec.ts\" --discover",
    credentials: [],
    plannedTrials: 7,
  })
  expect(mixed.rationale).toContain("amplifies the same signature")

  const investigate = buildDiagnosisRecommendation({
    elapsedMilliseconds: 0,
    observedRuns: 0,
    stage: "reproducer-created",
    status: "no-failure-observed",
    target: "tests/checkout.spec.ts",
    values: options(),
  })
  expect(investigate).toMatchObject({
    aiCostLimitUsd: 0.25,
    credentials: ["GROQ_API_KEY"],
    solariCostEstimateUsd: 0,
  })

  const repair = buildDiagnosisRecommendation({
    elapsedMilliseconds: 0,
    observedRuns: 0,
    stage: "investigated",
    status: "no-failure-observed",
    target: "tests/checkout.spec.ts",
    values: options(),
  })
  expect(repair).toMatchObject({
    credentials: ["GROQ_API_KEY", "SOLARI_API_KEY"],
    solariCostEstimateUsd: null,
  })
  expect(repair.solariCostNote).toContain("No reliable Solari cost estimate")

  const noTrigger = buildDiagnosisRecommendation({
    elapsedMilliseconds: 60_000,
    observedRuns: 16,
    stage: "no-signal-observed",
    status: "no-failure-observed",
    target: "tests/checkout.spec.ts",
    values: options(),
  })
  expect(noTrigger).toMatchObject({
    command: null,
    credentials: [],
    plannedTrials: 0,
    solariCostEstimateUsd: 0,
  })
  expect(noTrigger.rationale).toContain("no causal reproducer")
})

test("a default diagnosis runs a local scan without requesting provider work", async ({
  browserName: _browserName,
}, testInfo) => {
  testInfo.setTimeout(60_000)
  const artifactDirectory = testInfo.outputPath("adaptive diagnosis")
  await diagnose("tests/fixtures/checkout-regression.spec.ts", options({
    artifacts: artifactDirectory,
    runs: "2",
  }))

  const artifact = diagnosisArtifactSchema.parse(JSON.parse(await readFile(
    resolve(artifactDirectory, "diagnose.json"),
    "utf8",
  )))
  expect(artifact).toMatchObject({
    artifacts: {
      analysis: null,
      discovery: null,
      evidence: null,
      html: null,
      patch: null,
      proof: null,
      reproducer: null,
    },
    observation: { status: "no-failure-observed" },
    recommendation: { credentials: [], solariCostEstimateUsd: 0 },
    stage: "observed",
    status: "complete",
    usage: {
      actual: { executions: 2, solariSandboxesCreated: 0, solariSandboxesKilled: 0 },
      planned: { solariCostEstimateUsd: 0 },
    },
  })
  expect(artifact.inputHash).toMatch(/^[a-f\d]{64}$/u)
  expect(artifact.artifacts.scan).not.toBeNull()

  await resumeDiagnosis(resolve(artifactDirectory, "diagnose.json"))
  const resumed = diagnosisArtifactSchema.parse(JSON.parse(await readFile(
    resolve(artifactDirectory, "diagnose.json"),
    "utf8",
  )))
  expect(resumed.usage.actual.executions).toBe(2)
  expect(resumed.status).toBe("complete")
})
