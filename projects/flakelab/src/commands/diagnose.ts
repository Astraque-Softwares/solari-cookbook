import { readFile, stat } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { z } from "zod"

import { portableProjectPath } from "../artifacts/paths.js"
import {
  nextDiagnosisPhase,
  readDiagnosisCheckpoint,
} from "../diagnosis/checkpoint.js"
import {
  addDiagnosisUsage,
  analysisObservation,
  createDiagnosisContext,
  emptyObservation,
  emptyPaths,
  restoreDiagnosisContext,
  saveDiagnosis,
  scanObservation,
  updateDiagnosisWorkflow,
} from "../diagnosis/run-state.js"
import type {
  DiagnosisContext,
  DiagnosisPaths,
  Observation,
} from "../diagnosis/run-state.js"
import type { DiagnosisStage } from "../diagnosis/schema.js"
import { buildDiscoveryBudget } from "../diagnosis/discovery-budget.js"
import {
  requestSolariProof,
} from "../diagnosis/solari-handoff.js"
import { formatDiagnosisSummary } from "../diagnosis/summary.js"
import { discoverRepairSourceCandidates } from "../investigator/safe-source.js"
import type { RequiredExperimentEvidence } from "../investigator/agent.js"
import {
  experimentConditionSchema,
  experimentResultSchema,
} from "../investigator/schema.js"
import { preflightProofCredentials } from "../proof/preflight.js"
import { redactText } from "../report/redaction.js"
import { writeStdout } from "../ui/console.js"
import { stdoutTheme } from "../ui/theme.js"
import {
  integerOption,
  positiveNumberOption,
} from "./options.js"
import type { DiagnoseOptions } from "./options.js"

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
      json: false,
      runs: values.runs,
      verbose: false,
    })
    paths.scan = portableProjectPath(projectRoot, resolve(values.artifacts, "scan.json"))
    observation = scanObservation(scanned, Date.now() - scanStartedAt)
    process.exitCode = undefined
  }
  return observation
}

async function runDiscoveryStage(context: DiagnosisContext): Promise<void> {
  const { projectRoot, target, values } = context
  const { discover } = await import("./discover.js")
  const startedAt = Date.now()
  const result = await discover(target ?? "", {
    "animation-rate": "5",
    "clock-offset-ms": "3600000",
    concurrency: values.concurrency,
    fault: "network-delay",
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
  })
  context.checkpoint.artifacts.reproducer = portableProjectPath(projectRoot, values.reproducer)
  addDiagnosisUsage(context, {
    elapsedMilliseconds: Date.now() - startedAt,
    executions: result.baseline.trials
      + result.experiments.reduce(
        (total, experiment) => total + (
          "trials" in experiment ? experiment.trials : experiment.result.trials
        ),
        0,
      ),
  })
}

async function readRequiredExperimentEvidence(
  context: DiagnosisContext,
): Promise<RequiredExperimentEvidence | undefined> {
  const reproducer = context.checkpoint.artifacts.reproducer
  if (!reproducer) {
    return undefined
  }
  const reproducerPath = resolve(context.projectRoot, reproducer)
  const discoveryPath = resolve(
    dirname(reproducerPath),
    `${basename(reproducerPath, extname(reproducerPath))}.discovery.json`,
  )
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
    pattern: values.pattern,
    "prompt-credentials": values["prompt-credentials"],
    report: values.evidence,
    seed: values.seed,
    trials: values.trials,
  }, requiredEvidence)
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

async function runRepairStage(context: DiagnosisContext): Promise<DiagnosisStage> {
  const { projectRoot, values } = context
  const { repair } = await import("./repair.js")
  const startedAt = Date.now()
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
  })
  const repairRejected = process.exitCode === 1
  process.exitCode = undefined
  context.checkpoint.artifacts.patch = portableProjectPath(projectRoot, values.patch)
  context.checkpoint.artifacts.proof = portableProjectPath(projectRoot, values.proof)
  addDiagnosisUsage(context, {
    aiEstimatedCostUsd: result.usage.estimatedCostUsd,
    aiInputTokens: result.usage.inputTokens,
    aiOutputTokens: result.usage.outputTokens,
    elapsedMilliseconds: Date.now() - startedAt,
    executions: result.proof.beforeHostile.trials
      + result.proof.afterHostile.trials
      + result.proof.afterControl.trials
      + result.proof.regressions.reduce(
        (total, regression) => total + regression.result.trials,
        0,
      ),
    solariSandboxesCreated: 1,
    solariSandboxesKilled: 1,
    solariCostUsd: null,
  })
  context.checkpoint.cache = {
    key: null,
    reason: "Candidate proof uploads a unique patched workspace, so no prepared snapshot applies.",
    status: "not-used",
  }
  context.checkpoint.cleanup = { liveResources: 0, status: "confirmed" }
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
  })
  context.checkpoint.artifacts.html = portableProjectPath(projectRoot, values.html)
  if (repairRejected) {
    process.exitCode = 1
  }
  return stage
}

function finalStage(context: DiagnosisContext, stage: DiagnosisStage): boolean {
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

function validateResumePaths(context: DiagnosisContext): void {
  const { checkpoint, projectRoot, target, values } = context
  const optionPaths = [
    values.artifacts,
    values.baseline,
    values.evidence,
    values.html,
    values.patch,
    values.proof,
    values.report,
    values.reproducer,
    target,
  ]
  for (const path of optionPaths) {
    if (path) {
      confinedProjectPath(projectRoot, path)
    }
  }
  for (const path of Object.values(checkpoint.artifacts)) {
    if (path) {
      confinedProjectPath(projectRoot, path)
    }
  }
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
    await runDiscoveryStage(context)
    return "reproducer-created"
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

async function continueDiagnosis(context: DiagnosisContext): Promise<void> {
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
    if (nextDiagnosisPhase(context.checkpoint) === "repair") {
      context.checkpoint.cleanup = { liveResources: null, status: "unconfirmed" }
      context.checkpoint.usage.actual.solariCostUsd = null
    }
    await saveDiagnosis(
      context,
      context.checkpoint.stage,
      interrupted(error) ? "interrupted" : "failed",
      redactText(error.message).slice(0, 2_000),
    )
    throw error
  }
  writeStdout(formatDiagnosisSummary(context.checkpoint, portableArtifactPath, stdoutTheme()))
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

async function offerSolariProof(context: DiagnosisContext): Promise<void> {
  const { target, values } = context
  if (!target) {
    return
  }
  if (values.repair) {
    return
  }
  const request = await requestSolariProof(values.source, discoveryBudget(context), {
    discoverSources: async () => discoverRepairSourceCandidates(context.projectRoot, target),
  })
  if (!request) {
    return
  }
  await preflightProofCredentials(values["prompt-credentials"])
  updateDiagnosisWorkflow(context, {
    ...values,
    discover: true,
    investigate: true,
    "max-seconds": String(request.maxSeconds),
    repair: true,
    source: request.sources,
  })
  try {
    await continueDiagnosis(context)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Proof pipeline failed"
    const checkpoint = portableProjectPath(context.projectRoot, context.artifactPath)
    throw new Error(
      `${message}\nSaved completed stages. Resume with: flakelab resume "${checkpoint}"`,
      { cause },
    )
  }
}

export async function diagnose(
  target: string | undefined,
  values: DiagnoseOptions,
): Promise<void> {
  const projectRoot = process.cwd()
  const artifactPath = resolve(projectRoot, values.artifacts, "diagnose.json")
  const portableArtifactPath = portableProjectPath(projectRoot, artifactPath)
  const paths = emptyPaths()
  const wantsDiscovery = values.discover || values.investigate || values.repair
  const observation = await collectObservation(
    projectRoot,
    target,
    values,
    paths,
    wantsDiscovery,
  )
  const context = createDiagnosisContext({
    artifactPath,
    observation,
    paths,
    projectRoot,
    ...(target ? { target } : {}),
    values,
  })
  await saveDiagnosis(context, "observed", wantsDiscovery ? "running" : "complete")
  const supportsControlledDiscovery = observation.status === "no-failure-observed"
    || observation.status === "mixed-outcomes"
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
  await continueDiagnosis(context)
  await offerSolariProof(context)
}

export async function resumeDiagnosis(path: string): Promise<void> {
  const projectRoot = process.cwd()
  const artifactPath = resolve(projectRoot, path)
  const checkpoint = await readDiagnosisCheckpoint(artifactPath)
  const context = restoreDiagnosisContext(artifactPath, checkpoint, projectRoot)
  validateResumePaths(context)
  await continueDiagnosis(context)
}
