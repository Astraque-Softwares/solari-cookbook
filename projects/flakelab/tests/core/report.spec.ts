import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { investigationReportSchema } from "../../src/investigator/schema.js"
import { proofOfFixSchema } from "../../src/repair/schema.js"
import { writePortableReport } from "../../src/report/bundle.js"
import { buildEvidenceReport } from "../../src/report/model.js"
import { redactText } from "../../src/report/redaction.js"
import { reproducerSchema } from "../../src/reproducer/schema.js"

const investigation = investigationReportSchema.parse({
  version: 1,
  test: "tests/checkout.spec.ts",
  model: "test-model",
  conclusion: "A product race occurs when hydration finishes after the deadline.",
  conclusionHypothesisId: "H1",
  conclusionEvidenceIds: ["E1"],
  hypotheses: [
    {
      id: "H1",
      statement: "Hydration finishes after the product deadline.",
      prediction: "A delayed response will reproduce the failure.",
      status: "confirmed",
      evidenceExperimentIds: ["E1"],
      explanation: "The delayed response caused every trial to fail.",
    },
    {
      id: "H2",
      statement: "The selector intermittently resolves the wrong element.",
      prediction: "A clean baseline will reproduce selector failures.",
      status: "rejected",
      evidenceExperimentIds: ["E2"],
      explanation: "Every clean baseline trial passed.",
    },
  ],
  experiments: [
    {
      id: "E1",
      hypothesisId: "H1",
      condition: { kind: "network-delay", delayMs: 125 },
      result: {
        confirmed: true,
        errors: 0,
        failed: 4,
        failureRate: 1,
        lowerBound80: 0.71,
        passed: 0,
        trials: 4,
      },
    },
    {
      id: "E2",
      hypothesisId: "H2",
      condition: { kind: "baseline" },
      result: {
        confirmed: false,
        errors: 0,
        failed: 0,
        failureRate: 0,
        lowerBound80: 0,
        passed: 4,
        trials: 4,
      },
    },
  ],
  usage: { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.001 },
})

const cleanResult = {
  confirmed: false,
  errors: 0,
  failed: 0,
  failureRate: 0,
  lowerBound80: 0,
  passed: 4,
  trials: 4,
}

const proof = proofOfFixSchema.parse({
  version: 1,
  execution: "solari-microvm",
  patchAccepted: true,
  patchPath: "candidate.diff",
  staticChecks: { typecheck: true, lint: true },
  staticDiagnostics: {},
  beforeHostile: {
    ...cleanResult,
    confirmed: true,
    failed: 4,
    failureRate: 1,
    lowerBound80: 0.71,
    passed: 0,
  },
  afterHostile: cleanResult,
  afterControl: cleanResult,
  regressions: [{ selector: "tests/regression.spec.ts", result: cleanResult }],
})

const reproducer = reproducerSchema.parse({
  version: 1,
  test: investigation.test,
  seed: 42,
  trials: 4,
  faults: [{ kind: "network-delay", pattern: "**/api/checkout", delayMs: 125 }],
  expectedFailure: { minimumRate: 0.7, signature: "fixture-signature" },
})

function report() {
  return buildEvidenceReport({
    generatedAt: new Date("2026-09-03T00:00:00.000Z"),
    investigation,
    paths: {
      investigation: "flakelab.investigation.json",
      patch: "candidate.diff",
      proof: "flakelab.proof.json",
      reproducer: "flakelab.repro.yaml",
    },
    proof,
    reproducer,
  })
}

test("report model classifies evidence and redacts credentials", () => {
  const secret = "credential-value-that-must-not-remain"
  const redacted = redactText(
    `Authorization: Bearer ${secret} api_key=${secret} https://example.test/?token=${secret}`,
  )
  expect(redacted).not.toContain(secret)
  expect(redacted).toContain("[REDACTED]")
  expect(report()).toMatchObject({
    status: "FIX_PROVEN",
    ownership: { classification: "PRODUCT_RACE", confidence: "high" },
  })
})

test("portable report renders its causal evidence without a network dependency", async ({
  page,
}, testInfo) => {
  const outputPath = testInfo.outputPath("flakelab.report.html")
  await writePortableReport(process.cwd(), outputPath, report())
  const html = await readFile(outputPath, "utf8")
  expect(html).toContain("default-src 'none'")
  expect(html).not.toContain('<script type="module" src=')
  await page.goto(pathToFileURL(outputPath).href)

  await expect(page.getByRole("heading", { name: /We found what makes/u })).toBeVisible()
  await expect(page.getByText("Fix independently proven")).toBeVisible()
  await expect(page.getByRole("heading", { name: "PRODUCT RACE" })).toBeVisible()
  await expect(page.getByLabel("Before and after failure-rate chart").locator("svg")).toBeVisible()
  await expect(page.getByText("4/4 passed · 0% failure").first()).toBeVisible()
})
