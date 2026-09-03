import { config } from "dotenv"
import { execFile } from "node:child_process"
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { statisticalBisect } from "./bisect/engine.js"
import { resolveGitHistory } from "./bisect/git.js"
import { bisectReportSchema } from "./bisect/schema.js"
import { SolariRevisionEvaluator } from "./bisect/solari-evaluator.js"
import type { Reproducer } from "./reproducer/schema.js"
import { withSolariTransport } from "./solari/transport.js"

const execFileAsync = promisify(execFile)
const DEMO_DELAY_MS = 125
const DEMO_REPRODUCER: Reproducer = {
  version: 1,
  test: "tests/checkout.spec.ts",
  seed: 42,
  trials: 4,
  faults: [{ kind: "network-delay", pattern: "**/api/cart", delayMs: DEMO_DELAY_MS }],
  expectedFailure: { minimumRate: 0.7 },
}

function testSource(observationDelayMs: number): string {
  return `import { expect, test } from "@playwright/test"

test("checkout observes cart hydration", async () => {
  const delayMs = Number(process.env.FLAKELAB_NETWORK_DELAY_MS ?? "0")
  let hydrated = false
  const hydration = new Promise<void>((resolveHydration) => {
    setTimeout(() => {
      hydrated = true
      resolveHydration()
    }, delayMs)
  })
  await new Promise((resolveObservation) => setTimeout(resolveObservation, ${observationDelayMs}))
  expect(hydrated).toBe(true)
  await hydration
})
`
}

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

async function createDemoHistory(repository: string): Promise<{
  bad: string
  good: string
  regression: string
}> {
  await mkdir(join(repository, "tests"), { recursive: true })
  await git(repository, ["init", "--quiet"])
  await git(repository, ["config", "user.email", "flakelab@example.invalid"])
  await git(repository, ["config", "user.name", "FlakeLab Verification"])
  await copyFile(resolve("package.json"), join(repository, "package.json"))
  await copyFile(resolve("pnpm-lock.yaml"), join(repository, "pnpm-lock.yaml"))
  await copyFile(resolve("pnpm-workspace.yaml"), join(repository, "pnpm-workspace.yaml"))
  await writeFile(join(repository, ".gitignore"), "node_modules/\ntest-results/\n", "utf8")
  await writeFile(join(repository, "tests", "checkout.spec.ts"), testSource(175), "utf8")
  const good = await commit(repository, "checkout waits for cart hydration")
  await writeFile(join(repository, "README.md"), "# Checkout fixture\n", "utf8")
  await commit(repository, "document checkout fixture")
  await writeFile(join(repository, "tests", "checkout.spec.ts"), testSource(25), "utf8")
  const regression = await commit(repository, "enable checkout before cart hydration")
  await writeFile(join(repository, "README.md"), "# Checkout fixture\n\nRegression demonstration.\n", "utf8")
  const bad = await commit(repository, "document regression demonstration")
  return { bad, good, regression }
}

async function main(): Promise<void> {
  config({ quiet: true })
  const apiKey = process.env.SOLARI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("SOLARI_API_KEY is required for the live bisect verification")
  }
  const repository = await mkdtemp(join(tmpdir(), "flakelab-live-bisect-"))
  let evaluator: SolariRevisionEvaluator | undefined
  try {
    console.log("[1/4] Creating a four-commit demonstration history")
    const expected = await createDemoHistory(repository)
    const history = await resolveGitHistory(repository, expected.good, expected.bad)
    console.log("[2/4] Evaluating revisions in disposable Solari sandboxes")
    evaluator = new SolariRevisionEvaluator({
      apiKey,
      baseUrl: process.env.SOLARI_BASE_URL?.trim() ?? "https://api.getsolari.com",
      concurrency: 1,
      maxTrials: 12,
      minimumFailureRate: DEMO_REPRODUCER.expectedFailure.minimumRate,
      projectPath: history.projectPath,
      repositoryRoot: history.repositoryRoot,
      reproducer: DEMO_REPRODUCER,
    })
    const activeEvaluator = evaluator
    const report = await statisticalBisect({
      evaluate: async (revision) => {
        const evidence = await activeEvaluator.evaluate(revision)
        console.log(
          `  ${revision.shortHash} ${evidence.classification}`
          + ` · ${evidence.passed} passed, ${evidence.failed} failed, ${evidence.errors} errors`
          + ` · CI ${evidence.lowerBound80.toFixed(3)}–${evidence.upperBound80.toFixed(3)}`
          + ` · ${evidence.reason}`,
        )
        return evidence
      },
      minimumFailureRate: DEMO_REPRODUCER.expectedFailure.minimumRate,
      // Keep acceptance within the starter account's session quota. Parallel
      // midpoint preparation is verified by the deterministic core suite.
      parallelism: 1,
      revisions: history.revisions,
    })
    if (!report.exact || report.firstFailingCommit?.hash !== expected.regression) {
      throw new Error("statistical bisect did not identify the intentional regression")
    }
    console.log(`[3/4] Identified regression ${report.firstFailingCommit.shortHash}`)
    const artifactPath = resolve(".flakelab", "bisect-demo.json")
    await mkdir(resolve(".flakelab"), { recursive: true })
    await writeFile(
      artifactPath,
      `${JSON.stringify(bisectReportSchema.parse(report), null, 2)}\n`,
      "utf8",
    )
    console.log(`[4/4] Wrote evidence to ${artifactPath}`)
  } finally {
    await evaluator?.dispose()
    await rm(repository, { recursive: true, force: true })
  }
}

try {
  await withSolariTransport(main)
} catch (error) {
  console.error(error instanceof Error ? error.message : "Live bisect verification failed")
  process.exitCode = 1
}
