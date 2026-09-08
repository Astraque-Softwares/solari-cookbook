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

interface ValidationOptions {
  apiKey: string
  baseUrl: string
  candidate: CandidatePatch
  concurrency: number
  projectRoot: string
  reproducer: Reproducer
  signal?: AbortSignal
}

const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/u
const MAX_REGRESSION_SELECTORS = 5
const SKIPPED_DIRECTORIES = new Set([".flakelab", ".git", "node_modules"])

async function evaluate(
  root: string,
  selector: string,
  options: ValidationOptions,
  hostile: boolean,
  trials: number,
): Promise<ExperimentResult> {
  return evaluateExperiment(createPlaywrightExecutor(root, selector, { signal: options.signal }), {
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
): Promise<string[]> {
  const selected = resolve(root, selectedTest)
  const directories = new Set([
    dirname(selected),
    ...candidate.edits.map((edit) => dirname(resolve(root, edit.path))),
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
  const sourceLocations = await candidateSourceLocations(options.projectRoot, options.candidate)
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

  const workspace = await createPatchWorkspace(options.projectRoot)
  try {
    const diff = await applyCandidatePatch(workspace.root, options.candidate)
    const regressionSelectors = await nearbyRegressionSelectors(
      workspace.root,
      options.reproducer.test,
      options.candidate,
    )
    const remote = await validatePatchInSolari({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      concurrency: options.concurrency,
      regressionSelectors,
      reproducer: options.reproducer,
      signal: options.signal,
      workspaceRoot: workspace.uploadRoot,
      projectDirectory: workspace.projectDirectory,
    })
    const patchAccepted =
      remote.typecheck !== false
      && remote.lint !== false
      && passes(remote.afterHostile)
      && passes(remote.afterControl)
      && remote.regressions.every((entry) => passes(entry.result))
    return {
      diff,
      proof: proofOfFixSchema.parse({
        execution: "solari-microvm",
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
      }),
    }
  } finally {
    await workspace.cleanup()
  }
}
