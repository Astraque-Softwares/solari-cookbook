import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { z } from "zod"

import { portableProjectPath } from "../artifacts/paths.js"
import { nextDiagnosisPhase } from "../diagnosis/checkpoint.js"
import {
  addDiagnosisUsage,
  analysisObservation,
  createDiagnosisContext,
  emptyObservation,
  emptyPaths,
  saveDiagnosis,
  scanObservation,
} from "../diagnosis/run-state.js"
import type {
  DiagnosisContext,
  DiagnosisPaths,
  Observation,
} from "../diagnosis/run-state.js"
import type { DiagnosisStage } from "../diagnosis/schema.js"
import { formatDiagnosisSummary } from "../diagnosis/summary.js"
import type { RequiredExperimentEvidence } from "../investigator/agent.js"
import {
  experimentConditionSchema,
  experimentResultSchema,
} from "../investigator/schema.js"
import {
  assertRepositoryUnchanged,
  discoverAndWriteRepositoryProfile,
} from "../project/profile.js"
import type { RepositoryProfile } from "../project/schema.js"
import { redactText } from "../report/redaction.js"
import { SolariProofError } from "../repair/solari-validator.js"
import { writeStdout } from "../ui/console.js"
import { stdoutTheme } from "../ui/theme.js"
import { integerOption } from "./options.js"
import type { DiagnoseOptions } from "./options.js"
import type { RepairResult } from "./repair.js"
import type { ProofResources } from "../repair/solari-validator.js"
import { offerSolariProof } from "./diagnosis-proof-offer.js"
import { discoveryPathFor } from "./discovery-outcome.js"

const discoveryEvidenceSchema = z.object({
  trigger: experimentConditionSchema,
  triggerResult: experimentResultSchema,
})

function shouldRunScan(
  target: string | undefined,
  report: string | undefined,
  wantsDiscovery: boolean,
): boolean {
  if (!target) {
    return false
  }
  if (!report) {
    return true
  }
  return wantsDiscovery
}

async function collectObservation(
  projectRoot: string,
  target: string | undefined,
  values: DiagnoseOptions,
  paths: DiagnosisPaths,
  wantsDiscovery: boolean,
  repository?: RepositoryProfile,
): Promise<Observation> {
  let observation = emptyObservation()
  const startedAt = Date.now()
  if (values.report) {
    const { analyze } = await import("./analyze.js")
    const analysis = await analyze(values.report, {
      artifacts: values.artifacts,
      baseline: values.baseline,
      json: false,
      verbose: false,
    })
    paths.analysis = portableProjectPath(projectRoot, resolve(values.artifacts, "analyze.json"))
    observation = analysisObservation(analysis, Date.now() - startedAt)
    process.exitCode = undefined
  }
  if (shouldRunScan(target, values.report, wantsDiscovery)) {
    const scanStartedAt = Date.now()
    const { scan } = await import("./scan.js")
    const scanned = await scan(target ?? "", {
      artifacts: values.artifacts,
      concurrency: values.concurrency,
      config: values.config,
      json: false,
      runs: values.runs,
      verbose: false,
    }, repository)
    paths.scan = portableProjectPath(projectRoot, resolve(values.artifacts, "scan.json"))
    observation = scanObservation(scanned, Date.now() - scanStartedAt)
    process.exitCode = undefined
  }
  return observation
}

async function runDiscoveryStage(context: DiagnosisContext): Promise<DiagnosisStage> {
  const { projectRoot, target, values } = context
  const { discover } = await import("./discover.js")
  const startedAt = Date.now()
  if (!context.repository) throw new Error("Diagnosis repository profile is missing")
  const result = await discover(target ?? "", {
    "animation-rate": "5",
    "clock-offset-ms": "3600000",
    concurrency: values.concurrency,
    config: values.config,
    fault: "auto",
    "jump-after-ms": "0",
    locale: "fr-FR",
    "max-delay": values["max-delay"],
    "max-copies": "4",
    "max-duplicate-bytes": "1024",
    "max-hold-ms": "250",
    "max-remove-bytes": "1024",
    "max-seconds": values["max-seconds"],
    "max-stall-ms": "500",
    "max-workers": "4",
    "min-rate": values["min-rate"],
    output: values.reproducer,
    pattern: values.pattern,
    "resource-type": "script",
    seed: values.seed,
    "startup-event": "dom-content-loaded",
    "stall-after-ms": "0",
    storage: "local-storage",
    timezone: "America/New_York",
    trials: values.trials,
    "viewport-height": "667",
    "viewport-width": "375",
  }, context.repository, {
    scan: {
      clean: context.checkpoint.observation.status === "no-failure-observed",
      executions: context.checkpoint.observation.executions,
      workers: integerOption(values.concurrency, "concurrency"),
    },
    selectedTestCount: Math.max(1, context.checkpoint.observation.tests),
  })
  const discoveryPath = discoveryPathFor(resolve(projectRoot, values.reproducer))
  context.checkpoint.artifacts.discovery = portableProjectPath(projectRoot, discoveryPath)
  if ("screenings" in result) {
    addDiagnosisUsage(context, {
      elapsedMilliseconds: Date.now() - startedAt,
      executions: result.trials,
    })
    return "no-signal-observed"
  }
  context.checkpoint.artifacts.reproducer = portableProjectPath(projectRoot, values.reproducer)
  const screeningExecutions = result.automaticScreening?.reduce(
    (total, screening) => total + screening.trials,
    0,
  ) ?? 0
  addDiagnosisUsage(context, {
    elapsedMilliseconds: Date.now() - startedAt,
    executions: screeningExecutions
      + result.baseline.trials
      + result.experiments.reduce(
        (total, experiment) => total + (
          "trials" in experiment ? experiment.trials : experiment.result.trials
        ),
        0,
      ),
  })
  return "reproducer-created"
}

async function readRequiredExperimentEvidence(
  context: DiagnosisContext,
): Promise<RequiredExperimentEvidence | undefined> {
  const reproducer = context.checkpoint.artifacts.reproducer
  if (!reproducer) {
    return undefined
  }
  const reproducerPath = resolve(context.projectRoot, reproducer)
  const discoveryPath = discoveryPathFor(reproducerPath)
  const artifact = discoveryEvidenceSchema.parse(JSON.parse(
    await readFile(discoveryPath, { encoding: "utf8" }),
  ))
  return { condition: artifact.trigger, result: artifact.triggerResult }
}

async function runInvestigationStage(context: DiagnosisContext): Promise<void> {
  const { projectRoot, target, values } = context
  const { investigate } = await import("./investigate.js")
  const startedAt = Date.now()
  const requiredEvidence = await readRequiredExperimentEvidence(context)
  const evidencePattern = requiredEvidence && "pattern" in requiredEvidence.condition
    && typeof requiredEvidence.condition.pattern === "string"
    ? requiredEvidence.condition.pattern
    : undefined
  if (!context.repository) throw new Error("Diagnosis repository profile is missing")
  const report = await investigate(target ?? "", {
    concurrency: values.concurrency,
    "max-cost": values["max-cost"],
    "max-delay": values["max-delay"],
    "max-experiments": values["max-experiments"],
    "max-seconds": values["max-seconds"],
    "max-steps": values["max-steps"],
    "max-trials": values["max-trials"],
    "min-rate": values["min-rate"],
    model: values.model,
    pattern: evidencePattern ?? values.pattern,
    "prompt-credentials": values["prompt-credentials"],
    report: values.evidence,
    seed: values.seed,
    trials: values.trials,
  }, requiredEvidence, context.repository)
  context.checkpoint.artifacts.evidence = portableProjectPath(projectRoot, values.evidence)
  addDiagnosisUsage(context, {
    aiEstimatedCostUsd: report.usage.estimatedCostUsd,
    aiInputTokens: report.usage.inputTokens,
    aiOutputTokens: report.usage.outputTokens,
    elapsedMilliseconds: Date.now() - startedAt,
    executions: Math.max(0, report.experiments.reduce(
      (total, experiment) => total + experiment.result.trials,
      0,
    ) - (requiredEvidence?.result.trials ?? 0)),
  })
}

function recordProofUsage(
  context: DiagnosisContext,
  result: RepairResult,
  elapsedMilliseconds: number,
): void {
  addDiagnosisUsage(context, {
    aiEstimatedCostUsd: result.usage.estimatedCostUsd,
    aiInputTokens: result.usage.inputTokens,
    aiOutputTokens: result.usage.outputTokens,
    elapsedMilliseconds,
    executions: result.proof.beforeHostile.trials
      + result.proof.afterHostile.trials
      + result.proof.afterControl.trials
      + result.proof.regressions.reduce(
        (total, regression) => total + regression.result.trials,
        0,
      ),
    solariSandboxesCreated: result.proof.resources?.created ?? 0,
    solariSandboxesKilled: result.proof.resources?.released ?? 0,
    solariCostUsd: null,
  })
}

function recordProofCleanup(context: DiagnosisContext, resources?: ProofResources): void {
  context.checkpoint.cleanup = {
    liveResources: resources?.live ?? 0,
    status: resources ? "confirmed" : "unconfirmed",
  }
}

async function runRepairStage(context: DiagnosisContext): Promise<DiagnosisStage> {
  const { projectRoot, values } = context
  const { repair } = await import("./repair.js")
  const startedAt = Date.now()
  if (!context.repository) throw new Error("Diagnosis repository profile is missing")
  await assertRepositoryUnchanged(context.repository)
  const result = await repair(values.evidence, {
    concurrency: "1",
    "max-cost": values["max-cost"],
    "max-seconds": values["max-seconds"],
    model: values.model,
    patch: values.patch,
    proof: values.proof,
    "prompt-credentials": values["prompt-credentials"],
    reproducer: values.reproducer,
    source: values.source,
  }, context.repository)
  const repairRejected = process.exitCode === 1
  process.exitCode = undefined
  context.checkpoint.artifacts.patch = portableProjectPath(projectRoot, values.patch)
  context.checkpoint.artifacts.proof = portableProjectPath(projectRoot, values.proof)
  recordProofUsage(context, result, Date.now() - startedAt)
  context.checkpoint.cache = {
    key: null,
    reason: "Candidate proof uploads a unique patched workspace, so no prepared snapshot applies.",
    status: "not-used",
  }
  recordProofCleanup(context, result.proof.resources)
  const stage = repairRejected ? "repair-rejected" : "repair-proven"
  const { generateReport } = await import("./report.js")
  await generateReport(values.evidence, {
    html: values.html,
    open: values.open,
    patch: values.patch,
    proof: values.proof,
    "prompt-credentials": values["prompt-credentials"],
    publish: false,
    reproducer: values.reproducer,
  }, context.repository)
  context.checkpoint.artifacts.html = portableProjectPath(projectRoot, values.html)
  if (repairRejected) process.exitCode = 1
  return stage
}

function finalStage(context: DiagnosisContext, stage: DiagnosisStage): boolean {
  if (stage === "no-signal-observed") {
    return true
  }
  if (stage === "repair-proven" || stage === "repair-rejected") {
    return true
  }
  if (stage === "investigated") {
    return !context.values.repair
  }
  if (stage === "reproducer-created") {
    return !context.values.investigate && !context.values.repair
  }
  return !context.values.discover && !context.values.investigate && !context.values.repair
}

function confinedProjectPath(projectRoot: string, path: string): string {
  const absolute = resolve(projectRoot, path)
  const projectRelative = relative(projectRoot, absolute)
  if (projectRelative === ".." || projectRelative.startsWith(`..${sep}`)
    || isAbsolute(projectRelative)) {
    throw new Error("Diagnosis checkpoint artifact paths must stay inside the current project")
  }
  return absolute
}

async function requireCheckpointArtifact(
  context: DiagnosisContext,
  name: "evidence" | "reproducer",
): Promise<void> {
  const path = context.checkpoint.artifacts[name]
  if (!path) {
    throw new Error(`Diagnosis checkpoint is missing its ${name} artifact path`)
  }
  const details = await stat(confinedProjectPath(context.projectRoot, path))
  if (!details.isFile()) {
    throw new Error(`Diagnosis checkpoint ${name} artifact is not a file`)
  }
}

async function runNextPhase(context: DiagnosisContext): Promise<DiagnosisStage> {
  const phase = nextDiagnosisPhase(context.checkpoint)
  if (phase === "discover") {
    return runDiscoveryStage(context)
  }
  if (phase === "investigate") {
    await requireCheckpointArtifact(context, "reproducer")
    await runInvestigationStage(context)
    return "investigated"
  }
  if (phase === "repair") {
    await requireCheckpointArtifact(context, "reproducer")
    await requireCheckpointArtifact(context, "evidence")
    return runRepairStage(context)
  }
  return context.checkpoint.stage
}

function interrupted(error: Error): boolean {
  return error.name === "AbortError" || /abort|interrupt/iu.test(error.message)
}

function recordDiagnosisFailure(context: DiagnosisContext, error: Error): void {
  if (nextDiagnosisPhase(context.checkpoint) !== "repair") return
  if (error instanceof SolariProofError) {
    context.checkpoint.usage.actual.solariSandboxesCreated += error.resources.created
    context.checkpoint.usage.actual.solariSandboxesKilled += error.resources.released
    context.checkpoint.cleanup = {
      liveResources: error.resources.live,
      status: error.resources.live === 0 ? "confirmed" : "unconfirmed",
    }
  } else {
    context.checkpoint.cleanup = { liveResources: null, status: "unconfirmed" }
  }
  context.checkpoint.usage.actual.solariCostUsd = null
}

async function saveFailedDiagnosis(context: DiagnosisContext, error: Error): Promise<void> {
  recordDiagnosisFailure(context, error)
  await saveDiagnosis(
    context,
    context.checkpoint.stage,
    interrupted(error) ? "interrupted" : "failed",
    redactText(error.message).slice(0, 2_000),
  )
}

export async function continueSavedDiagnosis(context: DiagnosisContext): Promise<void> {
  const portableArtifactPath = portableProjectPath(context.projectRoot, context.artifactPath)
  if (nextDiagnosisPhase(context.checkpoint) === "complete") {
    const artifact = await saveDiagnosis(context, context.checkpoint.stage, "complete")
    writeStdout(formatDiagnosisSummary(artifact, portableArtifactPath, stdoutTheme()))
    return
  }
  await saveDiagnosis(context, context.checkpoint.stage, "running")
  try {
    while (nextDiagnosisPhase(context.checkpoint) !== "complete") {
      const stage = await runNextPhase(context)
      await saveDiagnosis(context, stage, finalStage(context, stage) ? "complete" : "running")
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("Diagnosis phase failed")
    await saveFailedDiagnosis(context, error)
    throw error
  }
  writeStdout(formatDiagnosisSummary(context.checkpoint, portableArtifactPath, stdoutTheme()))
}

export async function diagnose(
  target: string | undefined,
  values: DiagnoseOptions,
  repositoryRestart = 0,
): Promise<void> {
  const projectRoot = process.cwd()
  const repository = await discoverAndWriteRepositoryProfile({
    artifactDirectory: values.artifacts,
    config: values.config,
    invocationRoot: projectRoot,
    target,
  })
  const artifactPath = resolve(projectRoot, values.artifacts, "diagnose.json")
  const portableArtifactPath = portableProjectPath(projectRoot, artifactPath)
  const paths = emptyPaths()
  const wantsDiscovery = [values.discover, values.investigate, values.repair].includes(true)
  const observation = await collectObservation(
    projectRoot,
    target,
    values,
    paths,
    wantsDiscovery,
    repository,
  )
  const context = createDiagnosisContext({
    artifactPath,
    observation,
    paths,
    projectRoot,
    repository,
    target,
    values,
  })
  await saveDiagnosis(context, "observed", wantsDiscovery ? "running" : "complete")
  const supportsControlledDiscovery = ["no-failure-observed", "mixed-outcomes"]
    .includes(observation.status)
  if (!target || !supportsControlledDiscovery) {
    if (!wantsDiscovery) {
      writeStdout(formatDiagnosisSummary(context.checkpoint, portableArtifactPath, stdoutTheme()))
      return
    }
    const error = new Error(
      "Controlled discovery requires an explicit target with a measurable bounded control scan",
    )
    await saveDiagnosis(context, "observed", "failed", error.message)
    throw error
  }
  await continueSavedDiagnosis(context)
  await offerSolariProof(context, repositoryRestart, diagnose)
}

export async function resumeDiagnosis(path: string): Promise<void> {
  const { resumeSavedDiagnosis } = await import("./resume-diagnosis.js")
  await resumeSavedDiagnosis(path)
}
