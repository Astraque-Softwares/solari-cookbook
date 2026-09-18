import type { TestInfo } from "@playwright/test"
import { expect, test } from "@playwright/test"

import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  CandidateGenerationFailure,
  generateCandidatePatch,
} from "../../src/repair/generator.js"
import type { CandidatePatch } from "../../src/repair/schema.js"
import { investigationReportSchema } from "../../src/investigator/schema.js"

const testPath = "checkout.spec.ts"
const sourcePath = "checkout.ts"
const before = "const timeout = setTimeout(expire, 100)"

const investigation = investigationReportSchema.parse({
  conclusion: "Request completion loses ownership when delayed responses arrive.",
  conclusionEvidenceIds: ["E1"],
  conclusionHypothesisId: "H1",
  experiments: [{
    condition: { delayMs: 250, kind: "network-delay" },
    hypothesisId: "H1",
    id: "E1",
    result: {
      confirmed: true,
      errors: 0,
      failed: 4,
      failureRate: 1,
      failureSignatures: [],
      lowerBound80: 0.7,
      passed: 0,
      representativeRuns: [],
      trials: 4,
      upperBound80: 1,
    },
  }],
  hypotheses: [{
    evidenceExperimentIds: ["E1"],
    explanation: "Delay reproduced the request lifecycle race.",
    id: "H1",
    prediction: "Delayed responses expose lost request ownership.",
    statement: "Request completion loses ownership after cancellation.",
    status: "confirmed",
  }, {
    evidenceExperimentIds: [],
    explanation: "The alternative was not observed.",
    id: "H2",
    prediction: "Clean controls would fail without the delay.",
    statement: "The selected assertion targets unstable content.",
    status: "rejected",
  }],
  model: "fake-model",
  sourcePaths: [testPath, sourcePath],
  test: testPath,
  usage: { estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 },
})

async function fixture(testInfo: TestInfo): Promise<{
  artifacts: string
  root: string
}> {
  const root = testInfo.outputPath("candidate-project")
  const artifacts = testInfo.outputPath("custom-run", "candidates")
  await mkdir(root, { recursive: true })
  await writeFile(resolve(root, testPath), "test('checkout', async () => {})\n", "utf8")
  await writeFile(resolve(root, sourcePath), `${before}\n`, "utf8")
  return { artifacts, root }
}

function candidate(after: string, path = sourcePath): CandidatePatch {
  return {
    edits: [{ after, before, path }],
    rationale: "The request lifecycle should own completion and cancellation consistently.",
    summary: "Correct request lifecycle ownership for delayed responses",
  }
}

function usage(inputTokens: number, outputTokens: number) {
  return { estimatedCostUsd: 0, inputTokens, outputTokens }
}

async function captureGenerationFailure(
  operation: () => Promise<{ candidate: CandidatePatch }>,
): Promise<CandidateGenerationFailure> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof CandidateGenerationFailure) return error
    throw error
  }
  throw new Error("Expected candidate generation to fail")
}

test("a numeric-only first attempt receives a structured correction and a valid second attempt", async ({
  browserName: _browserName,
}, testInfo) => {
  const { artifacts, root } = await fixture(testInfo)
  const prompts: string[] = []
  const candidates = [
    candidate("const timeout = setTimeout(expire, 1000)"),
    candidate("const timeout = setTimeout(markSlow, 100)"),
  ]
  const generated = await generateCandidatePatch({
    artifactDirectory: artifacts,
    generate: (prompt, attempt) => {
      prompts.push(prompt)
      return Promise.resolve({
        candidate: candidates[attempt - 1],
        usage: usage(10 * attempt, 5 * attempt),
      })
    },
    investigation,
    maxCostUsd: 1,
    maxSeconds: 10,
    projectRoot: root,
    selectedTest: testPath,
    sourcePaths: [sourcePath],
    validateCandidate: () => Promise.resolve({ lint: true, testListed: true, typecheck: true }),
  })

  expect(generated.evidence.attemptCount).toBe(2)
  expect(generated.evidence.attempts.map((entry) => entry.outcome))
    .toEqual(["candidate-invalid", "valid"])
  expect(generated.evidence.attempts[0]?.rejection?.code).toBe("numeric-timing-increase")
  expect(prompts[0]).toContain("Do not increase timeouts or numeric timing thresholds")
  expect(prompts[0]).toContain("Prefer a structural application fix supported by the causal evidence")
  expect(prompts[0]).toContain("The repair must preserve normal behavior")
  expect(prompts[1]).toContain("Structured rejection code: numeric-timing-increase")
  expect(prompts[1]).toContain("Repeating the same semantic edit is invalid")
  expect(prompts[1]).toContain("Do not add sleeps")
  expect(await readFile(resolve(artifacts, "attempt-1.diff"), "utf8")).toContain("1000")
  expect(await readFile(resolve(artifacts, "attempt-2.validation.json"), "utf8"))
    .toContain('"outcome": "valid"')
})

test("two timing-only candidates retain both attempts, usage, and candidate-invalid evidence", async ({
  browserName: _browserName,
}, testInfo) => {
  const { artifacts, root } = await fixture(testInfo)
  const failure = await captureGenerationFailure(() => generateCandidatePatch({
      artifactDirectory: artifacts,
      generate: (_prompt, attempt) => Promise.resolve({
        candidate: candidate(`const timeout = setTimeout(expire, ${attempt * 1000})`),
        usage: usage(10, 4),
      }),
      investigation,
      maxCostUsd: 1,
      maxSeconds: 10,
      projectRoot: root,
      selectedTest: testPath,
      sourcePaths: [sourcePath],
      validateCandidate: () => Promise.reject(
        new Error("semantic rejection must happen before preflight"),
      ),
    }))

  expect(failure.candidateInvalid).toBe(true)
  expect(failure.evidence?.attemptCount).toBe(2)
  expect(failure.evidence?.usage).toMatchObject({ inputTokens: 20, outputTokens: 8 })
  expect(failure.evidence?.finalRejection?.code).toBe("numeric-timing-increase")
  for (const attempt of [1, 2]) {
    await expect(readFile(resolve(artifacts, `attempt-${attempt}.json`), "utf8"))
      .resolves.toContain("safe-candidate")
    await expect(readFile(resolve(artifacts, `attempt-${attempt}.validation.json`), "utf8"))
      .resolves.toContain("numeric-timing-increase")
  }
})

test("a one-call budget retains candidate-invalid evidence without a correction", async ({
  browserName: _browserName,
}, testInfo) => {
  const { artifacts, root } = await fixture(testInfo)
  let providerRequests = 0
  const failure = await captureGenerationFailure(() => generateCandidatePatch({
    artifactDirectory: artifacts,
    beforeProviderRequest: () => {
      providerRequests += 1
    },
    generate: () => Promise.resolve({
      candidate: candidate("const timeout = setTimeout(expire, 1000)"),
      usage: usage(10, 4),
    }),
    investigation,
    maxAttempts: 1,
    maxCostUsd: 1,
    maxSeconds: 10,
    projectRoot: root,
    selectedTest: testPath,
    sourcePaths: [sourcePath],
  }))

  expect(providerRequests).toBe(1)
  expect(failure.candidateInvalid).toBe(true)
  expect(failure.message).toContain("exhausted 1 attempt")
  expect(failure.evidence).toMatchObject({
    attemptCount: 1,
    correctiveAttemptOccurred: false,
    finalRejection: {
      code: "numeric-timing-increase",
      correctiveAttemptPermitted: false,
    },
  })
  await expect(access(resolve(artifacts, "attempt-2.json"))).rejects.toThrow()
})

test("unsafe paths retain metadata without reading or rendering the requested file", async ({
  browserName: _browserName,
}, testInfo) => {
  const { artifacts, root } = await fixture(testInfo)
  const failure = await captureGenerationFailure(() => generateCandidatePatch({
      artifactDirectory: artifacts,
      generate: () => Promise.resolve({
        candidate: candidate("const timeout = setTimeout(expire, 1000)", "../never-read.ts"),
        usage: usage(3, 2),
      }),
      investigation,
      maxCostUsd: 1,
      maxSeconds: 10,
      projectRoot: root,
      selectedTest: testPath,
      sourcePaths: [sourcePath],
    }))

  expect(failure.evidence?.attempts).toHaveLength(2)
  expect(failure.evidence?.attempts[0]).toMatchObject({
    candidatePath: null,
    diffRendered: false,
    rejection: { code: "unsafe-path" },
  })
  expect(await readFile(resolve(artifacts, "attempt-1.json"), "utf8"))
    .not.toContain("never-read.ts")
  expect(failure.evidence?.artifactPaths.some((path) => path.endsWith("attempt-1.diff")))
    .toBe(false)
})
