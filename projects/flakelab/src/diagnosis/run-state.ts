import { resolve } from "node:path"

import type { AnalysisArtifact } from "../analysis/schema.js"
import { portableProjectPath } from "../artifacts/paths.js"
import type { DiagnoseOptions } from "../commands/options.js"
import type { ScanArtifact, ScanStatus } from "../scan/schema.js"
import { portableRepositoryProfile } from "../project/profile.js"
import type { RepositoryProfile } from "../project/schema.js"
import type { CandidateGenerationEvidence } from "../repair/schema.js"
import {
  diagnosisInputHash,
  writeDiagnosisCheckpoint,
} from "./checkpoint.js"
import { buildDiagnosisRecommendation } from "./recommendation.js"
import type {
  DiagnosisArtifact,
  DiagnosisCheckpointOptions,
  DiagnosisStage,
} from "./schema.js"

export interface Observation {
  elapsedMilliseconds: number
  executions: number
  failures: number
  status: ScanStatus
  tests: number
}

export interface DiagnosisPaths {
  analysis: string | null
  discovery: string | null
  evidence: string | null
  html: string | null
  patch: string | null
  proof: string | null
  reproducer: string | null
  scan: string | null
}

export interface DiagnosisContext {
  artifactPath: string
  checkpoint: DiagnosisArtifact
  projectRoot: string
  repository?: RepositoryProfile
  target?: string
  values: DiagnoseOptions
}

export function scanObservation(scan: ScanArtifact, elapsedMilliseconds: number): Observation {
  return {
    elapsedMilliseconds,
    executions: scan.totals.executions,
    failures: scan.totals.failed,
    status: scan.status,
    tests: scan.tests.length,
  }
}

export function analysisObservation(
  analysis: AnalysisArtifact,
  elapsedMilliseconds: number,
): Observation {
  return {
    elapsedMilliseconds,
    executions: analysis.totals.executions,
    failures: analysis.totals.failed,
    status: analysis.status,
    tests: analysis.tests.length,
  }
}

export function emptyPaths(): DiagnosisPaths {
  return {
    analysis: null,
    discovery: null,
    evidence: null,
    html: null,
    patch: null,
    proof: null,
    reproducer: null,
    scan: null,
  }
}

export function emptyObservation(): Observation {
  return {
    elapsedMilliseconds: 0,
    executions: 0,
    failures: 0,
    status: "inconclusive",
    tests: 0,
  }
}

function portableOptionPath(projectRoot: string, path: string): string {
  return portableProjectPath(projectRoot, resolve(projectRoot, path))
}

function checkpointOptions(
  projectRoot: string,
  values: DiagnoseOptions,
): DiagnosisCheckpointOptions {
  return {
    ...values,
    artifacts: portableOptionPath(projectRoot, values.artifacts),
    baseline: values.baseline ? portableOptionPath(projectRoot, values.baseline) : null,
    evidence: portableOptionPath(projectRoot, values.evidence),
    html: portableOptionPath(projectRoot, values.html),
    patch: portableOptionPath(projectRoot, values.patch),
    proof: portableOptionPath(projectRoot, values.proof),
    report: values.report ? portableOptionPath(projectRoot, values.report) : null,
    reproducer: portableOptionPath(projectRoot, values.reproducer),
  }
}

export function updateDiagnosisWorkflow(
  context: DiagnosisContext,
  values: DiagnoseOptions,
): void {
  context.values = values
  context.checkpoint.input.options = checkpointOptions(context.projectRoot, values)
  context.checkpoint.input.report = values.report
    ? portableOptionPath(context.projectRoot, values.report)
    : null
  context.checkpoint.inputHash = diagnosisInputHash(context.checkpoint.input)
}

export function restoreDiagnosisOptions(checkpoint: DiagnosisArtifact): DiagnoseOptions {
  const { baseline, report, ...options } = checkpoint.input.options
  return {
    ...options,
    ...(baseline ? { baseline } : {}),
    ...(report ? { report } : {}),
  }
}

export function createDiagnosisContext(options: {
  artifactPath: string
  observation: Observation
  paths: DiagnosisPaths
  projectRoot: string
  repository?: RepositoryProfile
  target?: string
  values: DiagnoseOptions
}): DiagnosisContext {
  const createdAt = new Date().toISOString()
  const input = {
    options: checkpointOptions(options.projectRoot, options.values),
    report: options.values.report
      ? portableOptionPath(options.projectRoot, options.values.report)
      : null,
    target: options.target ? portableOptionPath(options.projectRoot, options.target) : null,
  }
  const recommendation = buildDiagnosisRecommendation({
    elapsedMilliseconds: options.observation.elapsedMilliseconds,
    observedExecutions: options.observation.executions,
    observedFailures: options.observation.failures,
    observedRuns: options.paths.scan ? Number(options.values.runs) : 0,
    selectedTestCount: options.observation.tests,
    stage: "observed",
    status: options.observation.status,
    target: options.target,
    values: options.values,
  })
  const checkpoint: DiagnosisArtifact = {
    artifacts: options.paths,
    cache: {
      key: null,
      reason: "No Solari operation has run in this diagnosis.",
      status: "not-used",
    },
    candidateGeneration: null,
    cleanup: { liveResources: 0, status: "not-required" },
    createdAt,
    input,
    inputHash: diagnosisInputHash(input),
    lastError: null,
    observation: options.observation,
    recommendation,
    ...(options.repository ? { repository: portableRepositoryProfile(options.repository) } : {}),
    stage: "observed",
    status: "running",
    updatedAt: createdAt,
    usage: {
      actual: {
        aiEstimatedCostUsd: 0,
        aiInputTokens: 0,
        aiOutputTokens: 0,
        elapsedMilliseconds: options.observation.elapsedMilliseconds,
        executions: options.observation.executions,
        solariCostUsd: 0,
        solariSandboxesCreated: 0,
        solariSandboxesKilled: 0,
      },
      planned: {
        aiCostLimitUsd: recommendation.aiCostLimitUsd,
        solariCostEstimateUsd: recommendation.solariCostEstimateUsd,
        trials: recommendation.plannedTrials,
      },
    },
  }
  return {
    artifactPath: options.artifactPath,
    checkpoint,
    projectRoot: options.projectRoot,
    ...(options.repository ? { repository: options.repository } : {}),
    ...(options.target ? { target: options.target } : {}),
    values: options.values,
  }
}

export function restoreDiagnosisContext(
  artifactPath: string,
  checkpoint: DiagnosisArtifact,
  projectRoot: string,
  repository?: RepositoryProfile,
): DiagnosisContext {
  const target = checkpoint.input.target ?? undefined
  return {
    artifactPath,
    checkpoint,
    projectRoot,
    ...(repository ? { repository } : {}),
    ...(target ? { target } : {}),
    values: restoreDiagnosisOptions(checkpoint),
  }
}

export function addDiagnosisUsage(context: DiagnosisContext, usage: {
  aiEstimatedCostUsd?: number
  aiInputTokens?: number
  aiOutputTokens?: number
  elapsedMilliseconds: number
  executions: number
  solariSandboxesCreated?: number
  solariSandboxesKilled?: number
  solariCostUsd?: number | null
}): void {
  const actual = context.checkpoint.usage.actual
  actual.aiEstimatedCostUsd += usage.aiEstimatedCostUsd ?? 0
  actual.aiInputTokens += usage.aiInputTokens ?? 0
  actual.aiOutputTokens += usage.aiOutputTokens ?? 0
  actual.elapsedMilliseconds += usage.elapsedMilliseconds
  actual.executions += usage.executions
  actual.solariSandboxesCreated += usage.solariSandboxesCreated ?? 0
  actual.solariSandboxesKilled += usage.solariSandboxesKilled ?? 0
  if (usage.solariCostUsd !== undefined) {
    actual.solariCostUsd = usage.solariCostUsd
  }
}

export async function recordCandidateGenerationProgress(
  context: DiagnosisContext,
  evidence: CandidateGenerationEvidence,
): Promise<void> {
  const previous = context.checkpoint.candidateGeneration?.usage
    ?? { estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 }
  addDiagnosisUsage(context, {
    aiEstimatedCostUsd: evidence.usage.estimatedCostUsd - previous.estimatedCostUsd,
    aiInputTokens: evidence.usage.inputTokens - previous.inputTokens,
    aiOutputTokens: evidence.usage.outputTokens - previous.outputTokens,
    elapsedMilliseconds: 0,
    executions: 0,
  })
  context.checkpoint.candidateGeneration = evidence
  await saveDiagnosis(context, "investigated", "running")
}

export async function saveDiagnosis(
  context: DiagnosisContext,
  stage: DiagnosisStage,
  status: DiagnosisArtifact["status"],
  lastError: string | null = null,
): Promise<DiagnosisArtifact> {
  const { checkpoint, target, values } = context
  const recommendation = buildDiagnosisRecommendation({
    elapsedMilliseconds: checkpoint.observation.elapsedMilliseconds,
    observedExecutions: checkpoint.observation.executions,
    observedFailures: checkpoint.observation.failures,
    observedRuns: checkpoint.artifacts.scan ? Number(values.runs) : 0,
    selectedTestCount: checkpoint.observation.tests,
    stage,
    status: checkpoint.observation.status,
    target,
    values,
  })
  checkpoint.lastError = lastError
  checkpoint.recommendation = recommendation
  checkpoint.stage = stage
  checkpoint.status = status
  checkpoint.updatedAt = new Date().toISOString()
  checkpoint.usage.planned = {
    aiCostLimitUsd: recommendation.aiCostLimitUsd,
    solariCostEstimateUsd: recommendation.solariCostEstimateUsd,
    trials: recommendation.plannedTrials,
  }
  await writeDiagnosisCheckpoint(context.artifactPath, checkpoint)
  return checkpoint
}
