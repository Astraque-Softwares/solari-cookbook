import { readFile, readdir } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import type { ExperimentResult } from "../discovery/evaluate.js"
import { evaluateExperiment } from "../discovery/evaluate.js"
import type { Reproducer } from "../reproducer/schema.js"
import { createPlaywrightExecutor } from "../runner/playwright-executor.js"
import type { CandidatePatch, ProofOfFix } from "./schema.js"
import { proofOfFixSchema } from "./schema.js"
import { validatePatchInSolari } from "./solari-validator.js"
import { applyCandidatePatch, createPatchWorkspace } from "./workspace.js"
import type { RepositoryProfile } from "../project/schema.js"
import { assertRepositoryUnchanged, repositoryEnvironment } from "../project/profile.js"

interface ValidationOptions {
  apiKey: string
  baseUrl: string
  candidate: CandidatePatch
  candidateRoot?: string
  concurrency: number
  projectRoot: string
  reproducer: Reproducer
  repository?: RepositoryProfile
  signal?: AbortSignal
}

const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/u
const MAX_REGRESSION_SELECTORS = 5
const SKIPPED_DIRECTORIES = new Set([".flakelab", ".git", "node_modules"])

function executorOptions(options: ValidationOptions) {
  if (!options.repository) return { signal: options.signal }
  return {
    artifactRoot: options.repository.artifactRoot,
    configPath: options.repository.playwright.configPath,
    environment: repositoryEnvironment(options.repository),
    playwrightCliPath: options.repository.playwright.cliPath,
    signal: options.signal,
  }
}

async function evaluate(
  root: string,
  selector: string,
  options: ValidationOptions,
  hostile: boolean,
  trials: number,
): Promise<ExperimentResult> {
  return evaluateExperiment(createPlaywrightExecutor(root, selector, executorOptions(options)), {
    concurrency: options.concurrency,
    faults: hostile ? options.reproducer.faults : [],
    minimumFailureRate: options.reproducer.expectedFailure.minimumRate,
    seed: options.reproducer.seed,
    signal: options.signal,
    trials,
  })
}

async function collectRegressionTests(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (files.length >= MAX_REGRESSION_SELECTORS + 1) {
      return
    }
    const path = join(directory, entry.name)
    if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
      await collectRegressionTests(path, files)
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      files.push(path)
    }
  }
}

export async function nearbyRegressionSelectors(
  root: string,
  selectedTest: string,
  candidate: CandidatePatch,
  candidateRoot = root,
): Promise<string[]> {
  const selected = resolve(root, selectedTest)
  const candidateDirectories = candidate.edits
    .map((edit) => dirname(resolve(candidateRoot, edit.path)))
    .filter((directory) => {
      const path = relative(root, directory)
      return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    })
  const directories = new Set([
    dirname(selected),
    ...candidateDirectories,
  ])
  const files: string[] = []
  for (const directory of directories) {
    await collectRegressionTests(directory, files)
  }
  const selectors = [...new Set(files)]
    .filter((path) => path !== selected)
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .sort((left, right) => left.localeCompare(right))
  return selectors.slice(0, MAX_REGRESSION_SELECTORS)
}

function passes(result: ExperimentResult): boolean {
  return result.errors === 0 && result.failed === 0 && result.passed === result.trials
}

function acceptsRemoteProof(remote: Awaited<ReturnType<typeof validatePatchInSolari>>): boolean {
  const staticChecksPass = remote.typecheck !== false && remote.lint !== false
  const regressionsPass = remote.regressions.every((entry) => passes(entry.result))
  return staticChecksPass
    && passes(remote.afterHostile)
    && passes(remote.afterControl)
    && regressionsPass
}

function candidateSourceRoot(options: ValidationOptions): string {
  return options.candidateRoot ?? options.projectRoot
}

async function candidateSourceLocations(
  projectRoot: string,
  candidate: CandidatePatch,
): Promise<Array<{ line: number; path: string }>> {
  return Promise.all(candidate.edits.map(async (edit) => {
    const content = await readFile(resolve(projectRoot, edit.path), "utf8")
    const offset = content.indexOf(edit.before)
    if (offset < 0) {
      throw new Error(`Candidate source location no longer exists in ${edit.path}`)
    }
    return {
      line: content.slice(0, offset).split(/\r?\n/u).length,
      path: edit.path,
    }
  }))
}

export async function validateProofOfFix(
  options: ValidationOptions,
  patchPath: string,
): Promise<{ diff: string; proof: ProofOfFix }> {
  const candidateRoot = candidateSourceRoot(options)
  const sourceLocations = await candidateSourceLocations(candidateRoot, options.candidate)
  const beforeHostile = await evaluate(
    options.projectRoot,
    options.reproducer.test,
    options,
    true,
    options.reproducer.trials,
  )
  const signatureMatches = !options.reproducer.expectedFailure.signature
    || beforeHostile.dominantFailureSignature === options.reproducer.expectedFailure.signature
  if (!beforeHostile.confirmed || !signatureMatches) {
    throw new Error("Original source no longer reproduces the expected hostile failure")
  }

  if (options.repository) await assertRepositoryUnchanged(options.repository)
  const workspace = await createPatchWorkspace(options.projectRoot)
  try {
    const diff = await applyCandidatePatch(workspace.uploadRoot, options.candidate)
    const regressionSelectors = await nearbyRegressionSelectors(
      workspace.root,
      options.reproducer.test,
      options.candidate,
      workspace.uploadRoot,
    )
    const remote = await validatePatchInSolari({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      concurrency: options.concurrency,
      ...(options.repository ? {
        configPath: relative(
          options.repository.executionRoot,
          options.repository.playwright.configPath,
        ).replaceAll("\\", "/"),
      } : {}),
      regressionSelectors,
      reproducer: options.reproducer,
      signal: options.signal,
      workspaceRoot: workspace.uploadRoot,
      projectDirectory: workspace.projectDirectory,
    })
    const patchAccepted = acceptsRemoteProof(remote)
    return {
      diff,
      proof: proofOfFixSchema.parse({
        execution: "solari-microvm",
        outcome: patchAccepted ? "candidate-proven" : "candidate-rejected",
        patchAccepted,
        patchPath,
        sourceLocations,
        staticChecks: { typecheck: remote.typecheck, lint: remote.lint },
        staticDiagnostics: {
          ...(remote.typecheckDiagnostic
            ? { typecheck: remote.typecheckDiagnostic }
            : {}),
          ...(remote.lintDiagnostic ? { lint: remote.lintDiagnostic } : {}),
        },
        beforeHostile,
        afterHostile: remote.afterHostile,
        afterControl: remote.afterControl,
        regressions: remote.regressions,
        resources: remote.resources,
      }),
    }
  } finally {
    await workspace.cleanup()
  }
}
