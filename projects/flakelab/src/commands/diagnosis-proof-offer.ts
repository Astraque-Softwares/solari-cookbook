import { readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { z } from "zod"

import { buildDiscoveryBudget } from "../diagnosis/discovery-budget.js"
import type { DiagnosisContext } from "../diagnosis/run-state.js"
import { updateDiagnosisWorkflow } from "../diagnosis/run-state.js"
import {
  requestLocalDiscoveryApproval,
  requestProofDiscoverySeconds,
  requestProofSources,
  requestProviderProofApproval,
} from "../diagnosis/solari-handoff.js"
import { discoverRankedRepairSourceCandidates } from "../investigator/safe-source.js"
import { preflightProofCredentials } from "../proof/preflight.js"
import { portableProjectPath } from "../artifacts/paths.js"
import { integerOption, positiveNumberOption } from "./options.js"
import type { DiagnoseOptions } from "./options.js"
import { verifyLocalRepository } from "./repository-drift.js"

type RestartDiagnosis = (
  target: string,
  values: DiagnoseOptions,
  repositoryRestart: number,
) => Promise<void>

const discoveryRelevanceSchema = z.object({
  trigger: z.object({
    pattern: z.string().optional(),
  }),
  triggerResult: z.object({
    dominantErrorReason: z.string().optional(),
    dominantFailureReason: z.string().optional(),
  }),
})

async function continueApprovedProof(context: DiagnosisContext): Promise<void> {
  const { continueSavedDiagnosis } = await import("./diagnose.js")
  if (context.checkpoint.stage !== "reproducer-created") return
  const sources = await requestProofSources(context.values.source, {
    discoverSources: async () => sourceSuggestions(context),
  })
  if (!sources) return
  await preflightProofCredentials(context.values["prompt-credentials"])
  updateDiagnosisWorkflow(context, {
    ...context.values,
    investigate: true,
    repair: true,
    source: sources,
  })
  await continueSavedDiagnosis(context)
}

function discoveryBudget(context: DiagnosisContext): {
  configuredSeconds: number
  estimatedSeconds: number
  recommendedSeconds: number
} {
  const { checkpoint, values } = context
  return buildDiscoveryBudget({
    concurrency: integerOption(values.concurrency, "concurrency"),
    configuredSeconds: positiveNumberOption(values["max-seconds"], "max-seconds"),
    elapsedMilliseconds: checkpoint.observation.elapsedMilliseconds,
    observedRuns: integerOption(values.runs, "runs"),
    plannedTrials: checkpoint.recommendation.plannedTrials,
  })
}

async function sourceSuggestions(context: DiagnosisContext): Promise<{
  path: string
  reason: string
}[]> {
  if (!context.repository) throw new Error("Diagnosis repository profile is missing")
  const test = context.repository.playwright.target.replace(/:\d+(?::\d+)?$/u, "")
  const workspaceTest = relative(
    context.repository.workspaceRoot,
    resolve(context.repository.executionRoot, test),
  ).replaceAll("\\", "/")
  const sources = await discoverRankedRepairSourceCandidates(
    context.repository.workspaceRoot,
    workspaceTest,
    await discoveryRelevance(context),
  )
  return sources.map((source) => ({
    path: relative(
      context.repository?.invocationRoot ?? context.projectRoot,
      resolve(context.repository?.workspaceRoot ?? context.projectRoot, source.path),
    ).replaceAll("\\", "/"),
    reason: source.reason,
  }))
}

async function discoveryRelevance(context: DiagnosisContext): Promise<string> {
  const discovery = context.checkpoint.artifacts.discovery
  if (!discovery) return ""
  try {
    const evidence = discoveryRelevanceSchema.parse(JSON.parse(
      await readFile(resolve(context.projectRoot, discovery), "utf8"),
    ))
    return [
      evidence.trigger.pattern,
      evidence.triggerResult.dominantFailureReason,
      evidence.triggerResult.dominantErrorReason,
    ].filter((value) => value !== undefined).join("\n")
  } catch {
    return ""
  }
}

async function runApprovedLocalDiscovery(context: DiagnosisContext): Promise<boolean> {
  if (context.checkpoint.stage !== "observed") return true
  if (!await requestLocalDiscoveryApproval()) return false
  const maxSeconds = await requestProofDiscoverySeconds(discoveryBudget(context))
  if (maxSeconds === null) return false
  updateDiagnosisWorkflow(context, {
    ...context.values,
    discover: true,
    investigate: false,
    "max-seconds": String(maxSeconds),
    repair: false,
  })
  const { continueSavedDiagnosis } = await import("./diagnose.js")
  await continueSavedDiagnosis(context)
  return true
}

async function runApprovedProviderProof(context: DiagnosisContext): Promise<void> {
  if (context.checkpoint.stage !== "reproducer-created") return
  if (!await requestProviderProofApproval()) return
  await continueApprovedProof(context)
}

export async function offerSolariProof(
  context: DiagnosisContext,
  repositoryRestart: number,
  restartDiagnosis: RestartDiagnosis,
): Promise<void> {
  const { target, values } = context
  if (!target || values.repair) return
  if (context.checkpoint.stage === "observed"
    && context.checkpoint.recommendation.command === null) return
  if (!context.repository) throw new Error("Diagnosis repository profile is missing")
  const stable = await verifyLocalRepository(
    context.repository,
    repositoryRestart,
    async () => restartDiagnosis(target, values, repositoryRestart + 1),
  )
  if (!stable) return
  try {
    if (!await runApprovedLocalDiscovery(context)) return
    await runApprovedProviderProof(context)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Proof pipeline failed"
    const checkpoint = portableProjectPath(context.projectRoot, context.artifactPath)
    throw new Error(
      `${message}\nSaved completed stages. Resume with: flakelab resume "${checkpoint}"`,
      { cause },
    )
  }
}
