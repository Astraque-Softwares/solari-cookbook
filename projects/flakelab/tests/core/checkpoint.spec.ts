import { expect, test } from "@playwright/test"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  diagnosisInputHash,
  nextDiagnosisPhase,
  readDiagnosisCheckpoint,
  writeDiagnosisCheckpoint,
} from "../../src/diagnosis/checkpoint.js"
import {
  restoreDiagnosisContext,
  updateDiagnosisWorkflow,
} from "../../src/diagnosis/run-state.js"
import { diagnosisArtifactSchema } from "../../src/diagnosis/schema.js"

function checkpoint() {
  const input = {
    options: {
      artifacts: ".flakelab/runs",
      baseline: null,
      concurrency: "1",
      discover: true,
      evidence: "flakelab.investigation.json",
      html: "flakelab.report.html",
      investigate: true,
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
      repair: true,
      report: null,
      reproducer: "flakelab.repro.yaml",
      runs: "4",
      seed: "1",
      source: [],
      trials: "4",
    },
    report: null,
    target: "tests/checkout.spec.ts",
  }
  return diagnosisArtifactSchema.parse({
    artifacts: {
      analysis: null,
      discovery: null,
      evidence: null,
      html: null,
      patch: null,
      proof: null,
      reproducer: null,
      scan: ".flakelab/runs/scan.json",
    },
    cache: {
      key: null,
      reason: "No Solari operation has run in this diagnosis.",
      status: "not-used",
    },
    cleanup: { liveResources: 0, status: "not-required" },
    createdAt: "2026-09-05T00:00:00.000Z",
    input,
    inputHash: diagnosisInputHash(input),
    lastError: null,
    observation: {
      elapsedMilliseconds: 100,
      executions: 4,
      failures: 0,
      status: "no-failure-observed",
      tests: 1,
    },
    recommendation: {
      aiCostLimitUsd: null,
      command: "flakelab diagnose tests/checkout.spec.ts --discover",
      credentials: [],
      expectedDuration: "about 1 minute",
      plannedTrials: 40,
      rationale: "Run bounded discovery.",
      solariCostEstimateUsd: 0,
      solariCostNote: "No Solari operation is planned.",
    },
    stage: "observed",
    status: "running",
    updatedAt: "2026-09-05T00:00:00.000Z",
    usage: {
      actual: {
        aiEstimatedCostUsd: 0,
        aiInputTokens: 0,
        aiOutputTokens: 0,
        elapsedMilliseconds: 100,
        executions: 4,
        solariCostUsd: 0,
        solariSandboxesCreated: 0,
        solariSandboxesKilled: 0,
      },
      planned: { aiCostLimitUsd: null, solariCostEstimateUsd: 0, trials: 40 },
    },
  })
}

test("resume planning starts after the last completed phase", () => {
  const observed = checkpoint()
  expect(nextDiagnosisPhase(observed)).toBe("discover")
  expect(nextDiagnosisPhase({ ...observed, stage: "no-signal-observed" })).toBe("complete")
  expect(nextDiagnosisPhase({ ...observed, stage: "reproducer-created" })).toBe("investigate")
  expect(nextDiagnosisPhase({ ...observed, stage: "investigated" })).toBe("repair")
  expect(nextDiagnosisPhase({ ...observed, stage: "repair-proven" })).toBe("complete")
  expect(nextDiagnosisPhase({ ...observed, stage: "candidate-invalid" })).toBe("complete")
})

test("candidate-invalid checkpoints retain bounded attempt usage and artifacts", () => {
  const value = diagnosisArtifactSchema.parse({
    ...checkpoint(),
    candidateGeneration: {
      artifactPaths: [
        ".flakelab/runs/custom/candidates/attempt-1.json",
        ".flakelab/runs/custom/candidates/attempt-1.validation.json",
      ],
      attemptCount: 1,
      attempts: [{
        artifactPaths: {
          candidate: ".flakelab/runs/custom/candidates/attempt-1.json",
          diff: null,
          validation: ".flakelab/runs/custom/candidates/attempt-1.validation.json",
        },
        attempt: 1,
        candidatePath: null,
        diffRendered: false,
        outcome: "candidate-invalid",
        rejection: {
          attempt: 1,
          code: "unsafe-path",
          correctiveAttemptPermitted: false,
          diffRendered: false,
          message: "Candidate edits must stay inside project source",
        },
        usage: { estimatedCostUsd: 0.001, inputTokens: 30, outputTokens: 10 },
      }],
      correctiveAttemptOccurred: false,
      finalRejection: {
        attempt: 1,
        code: "unsafe-path",
        correctiveAttemptPermitted: false,
        diffRendered: false,
        message: "Candidate edits must stay inside project source",
      },
      usage: { estimatedCostUsd: 0.001, inputTokens: 30, outputTokens: 10 },
    },
    stage: "candidate-invalid",
    status: "complete",
  })

  expect(value.candidateGeneration).toMatchObject({
    attemptCount: 1,
    finalRejection: { code: "unsafe-path" },
    usage: { inputTokens: 30, outputTokens: 10 },
  })
})

test("checkpoint writes replace atomically and validate their input hash", async ({
  browserName: _browserName,
}, testInfo) => {
  const path = testInfo.outputPath("diagnose.json")
  const first = checkpoint()
  await writeDiagnosisCheckpoint(path, first)
  const second = { ...first, status: "interrupted" as const, updatedAt: new Date().toISOString() }
  await writeDiagnosisCheckpoint(path, second)

  expect(await readDiagnosisCheckpoint(path)).toEqual(second)
  expect((await readdir(testInfo.outputDir)).filter((name) => name.endsWith(".tmp"))).toEqual([])

  const tampered = diagnosisArtifactSchema.parse(JSON.parse(await readFile(path, "utf8")))
  tampered.input.target = "tests/other.spec.ts"
  await writeFile(path, `${JSON.stringify(tampered)}\n`, "utf8")
  await expect(readDiagnosisCheckpoint(path)).rejects.toThrow("integrity hash")
})

test("interactive proof turns the observed checkpoint into a resumable workflow", () => {
  const context = restoreDiagnosisContext(
    resolve(".flakelab/runs/diagnose.json"),
    checkpoint(),
    resolve("."),
  )

  updateDiagnosisWorkflow(context, {
    ...context.values,
    discover: true,
    investigate: true,
    "max-seconds": "600",
    repair: true,
    source: ["src/checkout.ts"],
  })

  expect(nextDiagnosisPhase(context.checkpoint)).toBe("discover")
  expect(context.checkpoint.input.options).toMatchObject({
    discover: true,
    investigate: true,
    "max-seconds": "600",
    repair: true,
    source: ["src/checkout.ts"],
  })
  expect(context.checkpoint.inputHash).toBe(diagnosisInputHash(context.checkpoint.input))
})
