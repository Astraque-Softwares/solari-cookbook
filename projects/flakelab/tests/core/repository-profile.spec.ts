import { expect, test } from "@playwright/test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import {
  approveRepositorySources,
  assertRepositoryUnchanged,
  discoverRepositoryProfile,
  parseTestSelector,
  repositoryEnvironment,
  writeRepositoryProfile,
} from "../../src/project/profile.js"
import type { RepositoryProfile } from "../../src/project/schema.js"
import {
  newCandidateDiagnostics,
  preflightCandidate,
} from "../../src/repair/preflight.js"
import { projectPlan } from "../../src/repair/project-plan.js"
import { packageManager, workspaceRoot } from "../../src/repair/project.js"

test("test selectors retain Windows drives and optional locations", () => {
  expect(parseTestSelector("D:\\repo\\tests\\checkout.spec.ts:42:7")).toEqual({
    column: 7,
    file: "D:\\repo\\tests\\checkout.spec.ts",
    line: 42,
  })
})

test("repository discovery verifies and persists the selected Playwright test", async ({
  browserName: _browserName,
}, testInfo) => {
  const profile = await discoverRepositoryProfile({
    artifactDirectory: testInfo.outputPath("profile"),
    invocationRoot: process.cwd(),
    target: "tests/fixtures/checkout-regression.spec.ts:15",
  })
  const path = await writeRepositoryProfile(profile, testInfo.outputPath("profile"))
  const persisted = await readFile(path, "utf8")

  expect(profile.playwright.target).toBe("tests/fixtures/checkout-regression.spec.ts:15")
  expect(profile.playwright.configPath).toBe(resolve("playwright.config.ts"))
  expect(persisted).not.toContain(process.cwd())
  await expect(assertRepositoryUnchanged(profile)).resolves.toBeUndefined()
})

test("approved untracked source contents participate in repository drift checks", async ({
  browserName: _browserName,
}, testInfo) => {
  const profile = await discoverRepositoryProfile({
    artifactDirectory: testInfo.outputPath("profile"),
    invocationRoot: process.cwd(),
    target: "tests/fixtures/checkout-regression.spec.ts:15",
  })
  const source = testInfo.outputPath("approved-source.ts")
  await writeFile(source, "export const state = 'before'\n", "utf8")
  await approveRepositorySources(profile, [source])
  await expect(assertRepositoryUnchanged(profile)).resolves.toBeUndefined()

  await writeFile(source, "export const state = 'after'\n", "utf8")
  await expect(assertRepositoryUnchanged(profile)).rejects.toThrow(/changed during/u)
})

test("Nx capabilities disable its daemon and resolve project checks", async ({
  browserName: _browserName,
}, testInfo) => {
  const root = testInfo.outputPath("nx-workspace")
  const project = resolve(root, "apps/shop-e2e")
  await mkdir(project, { recursive: true })
  await writeFile(resolve(root, "package.json"), '{"private":true}\n', "utf8")
  await writeFile(resolve(root, "nx.json"), "{}\n", "utf8")
  await writeFile(resolve(project, "package.json"), '{"name":"shop-e2e"}\n', "utf8")

  await expect(workspaceRoot(project)).resolves.toBe(root)
  const plan = await projectPlan(root, "apps/shop-e2e")
  expect(plan.environment).toContain("NX_DAEMON=false")
  expect(plan.typecheck).toEqual({
    args: ["exec", "--", "nx", "run", "shop-e2e:typecheck"],
    command: "npm",
    directory: "",
  })
})

test("repository execution environment is selected by capability", async ({
  browserName: _browserName,
}) => {
  const profile = await discoverRepositoryProfile({
    artifactDirectory: ".flakelab/runs",
    invocationRoot: process.cwd(),
    target: "tests/fixtures/checkout-regression.spec.ts:15",
  })
  expect(repositoryEnvironment(profile)).toEqual({})
  expect(repositoryEnvironment({ ...profile, taskRunner: "nx" })).toEqual({ NX_DAEMON: "false" })
})

test("package managers are inferred from portable workspace capabilities", async ({
  browserName: _browserName,
}, testInfo) => {
  const fixtures = [
    { manager: "npm", marker: "package-lock.json" },
    { manager: "pnpm", marker: "pnpm-lock.yaml" },
    { manager: "yarn", marker: "yarn.lock" },
    { manager: "bun", marker: "bun.lock" },
  ] as const
  for (const fixture of fixtures) {
    const root = testInfo.outputPath(fixture.manager)
    await mkdir(root, { recursive: true })
    await writeFile(resolve(root, "package.json"), '{"private":true}\n', "utf8")
    await writeFile(resolve(root, fixture.marker), "", "utf8")
    await expect(packageManager(root)).resolves.toBe(fixture.manager)
  }
})

test("candidate syntax fails before a disposable proof is allocated", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "flakelab-preflight-"))
  const source = "src/checkout.ts"
  await mkdir(resolve(root, "src"), { recursive: true })
  await writeFile(resolve(root, source), "export function checkout() { return true }\n", "utf8")
  const profile: RepositoryProfile = {
    artifactRoot: root,
    discoveredAt: new Date().toISOString(),
    executionRoot: root,
    fingerprint: "a".repeat(64),
    installRoot: root,
    invocationRoot: root,
    packageManager: "npm",
    playwright: {
      cliPath: resolve("node_modules/@playwright/test/cli.js"),
      configPath: resolve("playwright.config.ts"),
      configuredRetries: 0,
      target: "tests/checkout.spec.ts:1",
      test: { column: 1, file: "tests/checkout.spec.ts", line: 1, projects: ["default"], title: "checkout" },
    },
    projectDirectory: "",
    reasons: [],
    sourceRoots: [root],
    taskRunner: "package-scripts",
    workspaceRoot: root,
  }
  try {
    await expect(preflightCandidate(profile, {
      summary: "Return a stable checkout result after processing completes",
      rationale: "The malformed candidate must be rejected before remote execution",
      edits: [{
        path: source,
        before: "export function checkout() { return true }",
        after: "export function checkout( { return true }",
      }],
    })).rejects.toThrow(/syntax is invalid/u)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("a valid candidate passes disposable checks and Playwright listing", async () => {
  test.setTimeout(300_000)
  const profile = await discoverRepositoryProfile({
    artifactDirectory: ".flakelab/runs",
    invocationRoot: process.cwd(),
    target: "tests/fixtures/checkout-regression.spec.ts:15",
  })

  await expect(preflightCandidate(profile, {
    summary: "Keep the checkout fixture behavior explicit during local validation",
    rationale: "Exercise static checks and Playwright listing inside a disposable copy",
    edits: [{
      path: "tests/support/checkout-server.ts",
      before: "status.textContent = 'Processing'",
      after: "status.textContent = 'Submitting'",
    }],
  })).resolves.toEqual({ lint: true, testListed: true, typecheck: true })
})

test("candidate preflight ignores unchanged baseline diagnostics", () => {
  const baseline = {
    diagnostic: "src/generated.ts(8,23): error TS2307: Cannot find module './generated.pegjs'",
    passed: false,
  }
  const candidate = {
    diagnostic: "src/generated.ts(8,23): error TS2307: Cannot find module './generated.pegjs'",
    passed: false,
  }

  expect(newCandidateDiagnostics(baseline, candidate)).toEqual([])
})

test("candidate preflight identifies newly introduced diagnostics", () => {
  const baseline = {
    diagnostic: "src/generated.ts(8,23): error TS2307: Cannot find module './generated.pegjs'",
    passed: false,
  }
  const candidate = {
    diagnostic: [
      baseline.diagnostic,
      "src/checkout.ts(12,4): error TS2322: Type 'string' is not assignable to type 'number'",
    ].join("\n"),
    passed: false,
  }

  expect(newCandidateDiagnostics(baseline, candidate)).toEqual([
    "src/checkout.ts(<line>,<column>): error TS2322: Type 'string' is not assignable to type 'number'",
  ])
})

test("candidate preflight ignores volatile formatter progress", () => {
  const baseline = {
    diagnostic: [
      "Checking formatting...",
      "src/a.ts (12ms)",
      "Format issues found in above 1 files. Run without `--check` to fix.",
      "Finished in 140ms on 20 files using 8 threads.",
    ].join("\n"),
    passed: false,
  }
  const candidate = {
    diagnostic: [
      "Checking formatting...",
      "src/a.ts (98.4ms)",
      "Format issues found in above 1 files. Run without `--check` to fix.",
      "Finished in 601.7ms on 20 files using 8 threads.",
    ].join("\n"),
    passed: false,
  }

  expect(newCandidateDiagnostics(baseline, candidate)).toEqual([])
})

test("candidate preflight rejects a silent check that starts failing", () => {
  expect(newCandidateDiagnostics(
    { diagnostic: "", passed: true },
    { diagnostic: "src/a.ts (12ms)", passed: false },
  )).toEqual(["check changed from passing to failing without a diagnostic"])
})
