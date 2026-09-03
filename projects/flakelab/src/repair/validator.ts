import { readdir } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

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

async function evaluate(
  root: string,
  selector: string,
  options: ValidationOptions,
  hostile: boolean,
  trials: number,
): Promise<ExperimentResult> {
  return evaluateExperiment(createPlaywrightExecutor(root, selector, { signal: options.signal }), {
    concurrency: options.concurrency,
    fault: hostile ? options.reproducer.faults[0] : undefined,
    minimumFailureRate: options.reproducer.expectedFailure.minimumRate,
    seed: options.reproducer.seed,
    signal: options.signal,
    trials,
  })
}

async function nearbyRegressionSelectors(root: string, selectedTest: string): Promise<string[]> {
  const directory = dirname(resolve(root, selectedTest))
  const selected = resolve(root, selectedTest)
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => resolve(directory, entry.name))
    .filter((path) => path !== selected)
    .map((path) => relative(root, path).replaceAll("\\", "/"))
}

function passes(result: ExperimentResult): boolean {
  return result.errors === 0 && result.failed === 0 && result.passed === result.trials
}

export async function validateProofOfFix(
  options: ValidationOptions,
  patchPath: string,
): Promise<{ diff: string; proof: ProofOfFix }> {
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
    )
    const remote = await validatePatchInSolari({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      concurrency: options.concurrency,
      regressionSelectors,
      reproducer: options.reproducer,
      signal: options.signal,
      workspaceRoot: workspace.root,
    })
    const patchAccepted =
      remote.typecheck
      && remote.lint
      && passes(remote.afterHostile)
      && passes(remote.afterControl)
      && remote.regressions.every((entry) => passes(entry.result))
    return {
      diff,
      proof: proofOfFixSchema.parse({
        version: 1,
        execution: "solari-microvm",
        patchAccepted,
        patchPath,
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
