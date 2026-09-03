import { expect, test } from "@playwright/test"
import { parse } from "yaml"
import { z } from "zod"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { selectChangedTests } from "../../src/ci/changed-tests.js"
import { buildJobSummary } from "../../src/ci/job-summary.js"
import type { InvestigationReport } from "../../src/investigator/schema.js"
import type { ProofOfFix } from "../../src/repair/schema.js"
import type { Reproducer } from "../../src/reproducer/schema.js"

const execFileAsync = promisify(execFile)

async function git(repository: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  })
  return result.stdout.trim()
}

async function commit(repository: string, message: string): Promise<string> {
  await git(repository, ["add", "."])
  await git(repository, ["commit", "--quiet", "-m", message])
  return git(repository, ["rev-parse", "HEAD"])
}

test("selects directly changed tests and falls back to bounded behavior tests", async () => {
  const repository = await mkdtemp(join(tmpdir(), "flakelab-ci-"))
  const project = join(repository, "project")
  try {
    await mkdir(join(project, "src"), { recursive: true })
    await mkdir(join(project, "tests", "e2e"), { recursive: true })
    await mkdir(join(project, "tests", "fixtures"), { recursive: true })
    await git(repository, ["init", "--quiet"])
    await git(repository, ["config", "user.email", "flakelab@example.invalid"])
    await git(repository, ["config", "user.name", "FlakeLab Test"])
    await writeFile(join(project, "src", "app.ts"), "export const ready = true\n", "utf8")
    await writeFile(join(project, "tests", "e2e", "checkout.spec.ts"), "// checkout\n", "utf8")
    await writeFile(join(project, "tests", "fixtures", "cart.spec.ts"), "// cart\n", "utf8")
    const base = await commit(repository, "initial fixture")
    await writeFile(join(project, "tests", "fixtures", "cart.spec.ts"), "// changed cart\n", "utf8")
    const directHead = await commit(repository, "change one test")

    const direct = await selectChangedTests(project, base, directHead)
    expect(direct.mode).toBe("direct")
    expect(direct.tests).toEqual(["tests/fixtures/cart.spec.ts"])

    await writeFile(join(project, "src", "app.ts"), "export const ready = false\n", "utf8")
    const sourceHead = await commit(repository, "change application behavior")
    const affected = await selectChangedTests(project, directHead, sourceHead)
    expect(affected.mode).toBe("affected-suite")
    expect(affected.tests).toEqual([
      "tests/e2e/checkout.spec.ts",
      "tests/fixtures/cart.spec.ts",
    ])
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
})

test("builds an escaped evidence summary with a trusted artifact link", () => {
  const reproducer: Reproducer = {
    version: 1,
    test: "tests/<checkout>.spec.ts",
    seed: 42,
    trials: 4,
    faults: [{ kind: "network-delay", pattern: "**/api/cart", delayMs: 125 }],
    expectedFailure: { minimumRate: 0.7 },
  }
  const result = {
    confirmed: false,
    errors: 0,
    failed: 0,
    failureRate: 0,
    lowerBound80: 0,
    passed: 4,
    trials: 4,
  }
  const proof: ProofOfFix = {
    version: 1,
    execution: "solari-microvm",
    patchAccepted: true,
    patchPath: "candidate.diff",
    staticChecks: { lint: true, typecheck: true },
    staticDiagnostics: {},
    beforeHostile: { ...result, confirmed: true, failed: 4, failureRate: 1, passed: 0 },
    afterHostile: result,
    afterControl: result,
    regressions: [],
  }
  const investigation: InvestigationReport = {
    version: 1,
    test: reproducer.test,
    model: "qwen/test",
    conclusion: "A <script> race was proven.",
    conclusionHypothesisId: "H1",
    conclusionEvidenceIds: ["E1"],
    hypotheses: [
      { id: "H1", statement: "A product race exists", prediction: "Delay changes failure rate", status: "confirmed", evidenceExperimentIds: ["E1"], explanation: "Proven" },
      { id: "H2", statement: "A selector race exists", prediction: "Locator change fixes it", status: "rejected", evidenceExperimentIds: [], explanation: "Rejected" },
    ],
    experiments: [{
      id: "E1",
      hypothesisId: "H1",
      condition: { kind: "network-delay", delayMs: 125 },
      result: proof.beforeHostile,
    }],
    usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
  }

  const summary = buildJobSummary({
    artifactUrl: "https://github.com/acme/repo/actions/runs/1/artifacts/2",
    investigation,
    proof,
    reproducer,
  })

  expect(summary).toContain("Candidate fix proved")
  expect(summary).toContain("&lt;checkout&gt;")
  expect(summary).toContain("A &lt;script&gt; race was proven.")
  expect(summary).toContain("[Download the portable evidence report](https://github.com/")
})

test("GitHub integration is least-privilege and guards secret-backed diagnosis", async () => {
  const actionPath = resolve(process.cwd(), "..", "..", ".github", "actions", "flakelab", "action.yml")
  const workflowPath = resolve(process.cwd(), "..", "..", ".github", "workflows", "flakelab.yml")
  const actionSchema = z.object({
    runs: z.object({
      using: z.literal("composite"),
      steps: z.array(z.looseObject({ uses: z.string().optional() })),
    }),
  })
  const workflowSchema = z.object({
    on: z.object({
      pull_request: z.object({ paths: z.array(z.string()).min(1) }),
      workflow_dispatch: z.object({ inputs: z.record(z.string(), z.object({})) }),
    }),
    permissions: z.object({ contents: z.literal("read") }),
    jobs: z.object({
      quality: z.object({
        "runs-on": z.literal("blacksmith-4vcpu-ubuntu-2404"),
      }),
      diagnosis: z.object({
        if: z.string().includes("head.repo.full_name == github.repository"),
        environment: z.literal("flakelab"),
        "runs-on": z.literal("blacksmith-4vcpu-ubuntu-2404"),
      }),
    }),
  })
  const actionSource = await readFile(actionPath, "utf8")
  const action = actionSchema.parse(parse(actionSource))
  const workflowSource = await readFile(workflowPath, "utf8")
  const workflow = workflowSchema.parse(parse(workflowSource))

  expect(action.runs.steps.some((step) => step.uses === "actions/upload-artifact@v7.0.1"))
    .toBe(true)
  expect(workflow.jobs.quality["runs-on"]).toBe("blacksmith-4vcpu-ubuntu-2404")
  expect(workflow.jobs.diagnosis["runs-on"]).toBe("blacksmith-4vcpu-ubuntu-2404")
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(actionSource).not.toContain("package-json-file")
  expect(workflowSource).not.toContain("package-json-file")
  expect(workflowSource).not.toContain("pull_request_target")
})
