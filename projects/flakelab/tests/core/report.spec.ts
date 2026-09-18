import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { investigationReportSchema } from "../../src/investigator/schema.js"
import type { ProofOfFix } from "../../src/repair/schema.js"
import { candidateInvalidProofSchema, proofOfFixSchema } from "../../src/repair/schema.js"
import { writePortableReport } from "../../src/report/bundle.js"
import { buildEvidenceReport } from "../../src/report/model.js"
import { redactText } from "../../src/report/redaction.js"
import { reproducerSchema } from "../../src/reproducer/schema.js"

const investigation = investigationReportSchema.parse({
  test: "tests/checkout.spec.ts",
  model: "test-model",
  sourcePaths: ["tests/checkout.spec.ts", "src/checkout.ts"],
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
        failureSignatures: [{
          failures: 4,
          failureRate: 1,
          lowerBound80: 0.71,
          signature: "checkout-timeout",
          upperBound80: 1,
        }],
        lowerBound80: 0.71,
        passed: 0,
        representativeRuns: [{
          artifacts: [{
            contentType: "application/zip",
            name: "trace",
            path: ".flakelab/test-results/failing/trace.zip",
          }],
          durationMs: 250,
          status: "failed",
          trialId: "experiment-1",
        }],
        trials: 4,
        upperBound80: 1,
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
        failureSignatures: [],
        lowerBound80: 0,
        passed: 4,
        representativeRuns: [{
          artifacts: [{
            contentType: "application/zip",
            name: "trace",
            path: ".flakelab/test-results/passing/trace.zip",
          }],
          durationMs: 80,
          status: "passed",
          trialId: "experiment-1",
        }],
        trials: 4,
        upperBound80: 0.29,
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
  failureSignatures: [],
  lowerBound80: 0,
  passed: 4,
  trials: 4,
  upperBound80: 0.29,
}

const hostileResult = {
  ...cleanResult,
  confirmed: true,
  failed: 4,
  failureRate: 1,
  failureSignatures: [{
    failures: 4,
    failureRate: 1,
    lowerBound80: 0.71,
    signature: "checkout-timeout",
    upperBound80: 1,
  }],
  lowerBound80: 0.71,
  passed: 0,
  upperBound80: 1,
}

function proofOfFix(accepted: boolean): ProofOfFix {
  return proofOfFixSchema.parse({
    execution: "solari-microvm",
    patchAccepted: accepted,
    patchPath: "candidate.diff",
    sourceLocations: [{ line: 42, path: "src/checkout.ts" }],
    staticChecks: { typecheck: true, lint: accepted },
    staticDiagnostics: {},
    beforeHostile: hostileResult,
    afterHostile: accepted ? cleanResult : hostileResult,
    afterControl: cleanResult,
    regressions: [{ selector: "tests/regression.spec.ts", result: cleanResult }],
  })
}

const reproducer = reproducerSchema.parse({
  test: investigation.test,
  seed: 42,
  trials: 4,
  faults: [
    {
      kind: "event-loop-stall",
      pattern: "**/event-loop",
      startAfterMs: 0,
      durationMs: 400,
    },
    { kind: "network-delay", pattern: "**/api/checkout", delayMs: 125 },
    { kind: "response-duplication", pattern: "**/api/checkout", duplicateBytes: 1 },
    { kind: "response-reordering", pattern: "**/api/checkout", holdMs: 30 },
    {
      kind: "resource-loading-delay",
      pattern: "**/assets/*",
      resourceType: "script",
      delayMs: 100,
    },
    { kind: "response-truncation", pattern: "**/api/checkout", removeBytes: 1 },
    {
      kind: "startup-event-delay",
      pattern: "**/hydration",
      event: "dom-content-loaded",
      delayMs: 750,
    },
    {
      kind: "storage-state-delay",
      pattern: "**/storage-auth",
      storage: "local-storage",
      key: "auth-token",
      delayMs: 250,
    },
  ],
  expectedFailure: { minimumRate: 0.7, signature: "fixture-signature" },
})

function report(accepted = true) {
  return buildEvidenceReport({
    generatedAt: new Date("2026-09-03T00:00:00.000Z"),
    investigation,
    paths: {
      investigation: "flakelab.investigation.json",
      patch: "candidate.diff",
      proof: "flakelab.proof.json",
      reproducer: "flakelab.repro.yaml",
    },
    proof: proofOfFix(accepted),
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
    causalClaim: {
      controlExperimentIds: ["E2"],
      interventionExperimentIds: ["E1"],
    },
    replayCommand: "flakelab replay \"flakelab.repro.yaml\" --concurrency 1",
    sourcePaths: ["tests/checkout.spec.ts", "src/checkout.ts"],
    status: "FIX_PROVEN",
    ownership: { classification: "PRODUCT_RACE", confidence: "high" },
  })
  expect(report(false)).toMatchObject({ status: "PATCH_REJECTED" })
  expect(() => buildEvidenceReport({
    investigation: investigationReportSchema.parse({
      ...investigation,
      sourcePaths: ["https://attacker.invalid/source.ts"],
    }),
    paths: {
      investigation: "flakelab.investigation.json",
      patch: "candidate.diff",
      proof: "flakelab.proof.json",
      reproducer: "flakelab.repro.yaml",
    },
    proof: proofOfFix(true),
    reproducer,
  })).toThrow("safe project-relative paths")
})

test("report model explains runner-level shared-state evidence", () => {
  const runnerInvestigation = investigationReportSchema.parse({
    ...investigation,
    experiments: investigation.experiments.map((experiment) => experiment.id === "E1"
      ? { ...experiment, condition: { copies: 2, kind: "shared-state-interference" } }
      : experiment),
  })
  const runnerReproducer = reproducerSchema.parse({
    ...reproducer,
    faults: [{
      copies: 2,
      kind: "shared-state-interference",
      pattern: "tests/checkout.spec.ts",
    }],
  })
  const runnerReport = buildEvidenceReport({
    generatedAt: new Date("2026-09-03T00:00:00.000Z"),
    investigation: runnerInvestigation,
    paths: {
      investigation: "flakelab.investigation.json",
      patch: "candidate.diff",
      proof: "flakelab.proof.json",
      reproducer: "flakelab.repro.yaml",
    },
    proof: proofOfFix(true),
    reproducer: runnerReproducer,
  })

  expect(runnerReport.experiments[0]?.condition)
    .toBe("Shared-state interference from 2 overlapping copies")
  expect(runnerReport.trigger.faults).toEqual(runnerReproducer.faults)
})

test("portable report renders its causal evidence without a network dependency", async ({
  page,
}, testInfo) => {
  const outputPath = testInfo.outputPath("flakelab.report.html")
  await writePortableReport(process.cwd(), outputPath, report())
  const html = await readFile(outputPath, "utf8")

  // The policy stays closed: no origin may be fetched, only inline and data resources.
  expect(html).toContain("default-src 'none'")
  expect(html).toContain("font-src data:")
  expect(html).not.toMatch(/(?:default|script|style|font|img)-src[^;"]*https?:/u)
  // Nothing is loaded from a sibling file, so the report survives being moved.
  expect(html).not.toContain('<script type="module" src=')
  expect(html).not.toContain("<link rel=\"stylesheet\"")
  // Geist Mono ships inside the document rather than from a font CDN.
  expect(html).toContain("data:font/woff2;base64,")
  expect(html).not.toContain("fonts.googleapis.com")
  expect(html).not.toContain("fonts.gstatic.com")

  const offOrigin: string[] = []
  page.on("request", (request) => {
    const url = request.url()
    if (!url.startsWith("file:") && !url.startsWith("data:")) {
      offOrigin.push(url)
    }
  })
  await page.goto(pathToFileURL(outputPath).href)

  // The verdict, its supporting classification, and the root cause are all readable.
  await expect(page.getByRole("heading", { name: "Verdict" })).toBeVisible()
  await expect(page.getByText("FIX PROVEN")).toBeVisible()
  await expect(page.getByText("PRODUCT_RACE")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Root cause" })).toBeVisible()
  await expect(
    page.getByText("A product race occurs when hydration finishes after the deadline."),
  ).toBeVisible()

  // The reproduction recipe keeps every field a reader needs to trigger the failure again.
  const reproduction = page.getByRole("region", { name: "Reproduction" })
  await expect(reproduction.getByText("**/api/checkout")).toHaveCount(4)
  await expect(reproduction.getByText("**/assets/*")).toBeVisible()
  await expect(reproduction.getByText("**/event-loop")).toBeVisible()
  await expect(reproduction.getByText("**/hydration")).toBeVisible()
  await expect(reproduction.getByText("**/storage-auth")).toBeVisible()
  await expect(reproduction.getByText("125 ms")).toBeVisible()
  await expect(reproduction.getByText("duplicate 1 response byte")).toBeVisible()
  await expect(reproduction.getByText("hold first response in each pair 30 ms")).toBeVisible()
  await expect(reproduction.getByText("delay script loading 100 ms")).toBeVisible()
  await expect(reproduction.getByText("stall event loop 400 ms after 0 ms")).toBeVisible()
  await expect(reproduction.getByText("delay dom-content-loaded listeners 750 ms")).toBeVisible()
  await expect(reproduction.getByText("hide local-storage key auth-token for 250 ms")).toBeVisible()
  await expect(reproduction.getByText("remove 1 response byte")).toBeVisible()
  await expect(reproduction.getByText("fixture-signature")).toBeVisible()
  await expect(reproduction.getByText(
    'flakelab replay "flakelab.repro.yaml" --concurrency 1',
  )).toBeVisible()
  await expect(reproduction.getByRole("heading", { name: "Passing control" })).toBeVisible()
  await expect(reproduction.getByRole("heading", { name: "Failing intervention" })).toBeVisible()

  // The before/after comparison is a named figure, not a decorative graphic.
  const delta = page.getByRole("figure", { name: /before and after the candidate patch/u })
  await expect(delta).toBeVisible()
  await expect(delta.getByText("100%", { exact: true })).toBeVisible()
  await expect(delta.getByText("0%", { exact: true })).toBeVisible()

  // Both evidence tables stay reachable and keep their numbers.
  const experiments = page.getByRole("region", { name: "Experiment record" })
  await expect(experiments.getByRole("row", { name: /E1/u })).toBeVisible()
  await expect(experiments.getByRole("link", { name: "trace" })).toHaveCount(2)
  await expect(page.getByRole("link", { name: "E1" }).first())
    .toHaveAttribute("href", "#exp-E1")
  await expect(page.getByText("src/checkout.ts", { exact: true })).toBeVisible()
  await expect(page.getByText("src/checkout.ts:42", { exact: true })).toBeVisible()
  const matrix = page.getByRole("region", { name: "Proof matrix" })
  await expect(matrix.getByRole("row", { name: /After · hostile/u })).toContainText("PASS")

  expect(await page.evaluate(() => document.fonts.ready.then(() =>
    [...document.fonts].some((face) => face.family === "Geist Mono Variable")))).toBe(true)

  expect(offOrigin).toEqual([])
})

test("portable report stays usable on a narrow screen and from the keyboard", async ({
  page,
}, testInfo) => {
  const outputPath = testInfo.outputPath("flakelab.report.html")
  await writePortableReport(process.cwd(), outputPath, report())
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(pathToFileURL(outputPath).href)

  // Long paths and wide tables must not push the document sideways.
  const overflow = await page.evaluate(() => {
    const root = document.documentElement
    return root.scrollWidth - root.clientWidth
  })
  expect(overflow).toBeLessThanOrEqual(1)

  // Tabbing to an artifact link must produce a visible focus indicator.
  let reached = false
  for (let step = 0; step < 60 && !reached; step += 1) {
    await page.keyboard.press("Tab")
    reached = await page.evaluate(() => document.activeElement instanceof HTMLAnchorElement
      && document.activeElement.getAttribute("href") === "flakelab.investigation.json")
  }
  expect(reached).toBe(true)
  const focusRing = await page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) {
      return { style: "none", width: "0px" }
    }
    const computed = getComputedStyle(active)
    return { style: computed.outlineStyle, width: computed.outlineWidth }
  })
  expect(focusRing.style).not.toBe("none")
  expect(Number.parseFloat(focusRing.width)).toBeGreaterThanOrEqual(2)
})

test("portable report presents a rejected candidate without claiming a fix", async ({
  page,
}, testInfo) => {
  const outputPath = testInfo.outputPath("flakelab.rejected.html")
  await writePortableReport(process.cwd(), outputPath, report(false))
  await page.goto(pathToFileURL(outputPath).href)

  await expect(page.getByText("PATCH REJECTED")).toBeVisible()
  await expect(page.getByText("FIX PROVEN")).toBeHidden()
  // The failing static check and the still-hostile result both stay on the page.
  const proof = page.getByRole("region", { name: "Proof of repair" })
  await expect(proof.getByRole("row", { name: /After · hostile/u })).toContainText("FAIL")
  await expect(proof.getByTestId("check-eslint")).toContainText("FAIL")
})

test("candidate-invalid report shows retained attempts without fabricating proof rows", async ({
  page,
}, testInfo) => {
  const invalidProof = candidateInvalidProofSchema.parse({
    candidateGeneration: {
      artifactPaths: [
        ".flakelab/runs/custom/candidates/attempt-1.json",
        ".flakelab/runs/custom/candidates/attempt-1.diff",
        ".flakelab/runs/custom/candidates/attempt-1.validation.json",
      ],
      attemptCount: 1,
      attempts: [{
        artifactPaths: {
          candidate: ".flakelab/runs/custom/candidates/attempt-1.json",
          diff: ".flakelab/runs/custom/candidates/attempt-1.diff",
          validation: ".flakelab/runs/custom/candidates/attempt-1.validation.json",
        },
        attempt: 1,
        candidatePath: "src/checkout.ts",
        diffRendered: true,
        outcome: "candidate-invalid",
        rejection: {
          attempt: 1,
          candidatePath: "src/checkout.ts",
          code: "numeric-timing-increase",
          correctiveAttemptPermitted: false,
          diffRendered: true,
          message: "Candidate only raises a numeric timing limit in src/checkout.ts",
        },
        usage: { estimatedCostUsd: 0.002, inputTokens: 80, outputTokens: 20 },
      }],
      correctiveAttemptOccurred: false,
      finalRejection: {
        attempt: 1,
        candidatePath: "src/checkout.ts",
        code: "numeric-timing-increase",
        correctiveAttemptPermitted: false,
        diffRendered: true,
        message: "Candidate only raises a numeric timing limit in src/checkout.ts",
      },
      usage: { estimatedCostUsd: 0.002, inputTokens: 80, outputTokens: 20 },
    },
    execution: "local-validation",
    outcome: "candidate-invalid",
    patchAccepted: false,
    patchPath: "candidate.diff",
    resources: { created: 0, live: 0, released: 0 },
    sourceLocations: [],
    staticChecks: { lint: null, typecheck: null },
    staticDiagnostics: {},
  })
  const invalidReport = buildEvidenceReport({
    generatedAt: new Date("2026-09-03T00:00:00.000Z"),
    investigation,
    paths: {
      investigation: "flakelab.investigation.json",
      patch: "candidate.diff",
      proof: "flakelab.proof.json",
      reproducer: "flakelab.repro.yaml",
    },
    proof: invalidProof,
    reproducer,
  })
  expect(invalidReport).toMatchObject({
    status: "CANDIDATE_INVALID",
    proof: { matrix: [], resources: { created: 0, live: 0, released: 0 } },
    usage: { candidateGeneration: { inputTokens: 80, outputTokens: 20 } },
  })

  const outputPath = testInfo.outputPath("flakelab.candidate-invalid.html")
  await writePortableReport(process.cwd(), outputPath, invalidReport)
  await page.goto(pathToFileURL(outputPath).href)
  await expect(page.getByText("CANDIDATE INVALID")).toBeVisible()
  await expect(page.getByRole("region", { name: "Candidate attempts" })).toContainText(
    "numeric-timing-increase",
  )
  await expect(page.getByRole("region", { name: "Proof matrix" })).toHaveCount(0)
  await expect(page.getByText("No Solari proof matrix ran for an invalid candidate.")).toBeVisible()
})
