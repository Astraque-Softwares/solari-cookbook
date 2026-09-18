import type { ExperimentCondition, InvestigationReport } from "../investigator/schema.js"
import type { RepairEvidence } from "../repair/schema.js"
import type { Reproducer } from "../reproducer/schema.js"
import { classifyFailure } from "./classification.js"
import { redactText } from "./redaction.js"
import type { EvidenceReport } from "./schema.js"
import { evidenceReportSchema } from "./schema.js"

interface ReportPaths {
  investigation: string
  patch: string
  proof: string
  reproducer: string
}

interface BuildReportOptions {
  generatedAt?: Date
  investigation: InvestigationReport
  paths: ReportPaths
  proof: RepairEvidence
  repository?: {
    fingerprint: string
  }
  reproducer: Reproducer
}

function safeReportPath(path: string): string {
  const normalized = path.replaceAll("\\", "/")
  const segments = normalized.split("/")
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized)
    || /^[a-z][a-z\d+.-]*:/iu.test(normalized) || segments.includes("..")
    || /[\0\r\n]/u.test(normalized)) {
    throw new Error("Evidence links must be safe project-relative paths")
  }
  return redactText(normalized)
}

type StateCondition = Extract<ExperimentCondition, {
  kind: "auth-cookie-expiry" | "storage-state-delay"
}>
type TemporalCondition = Extract<ExperimentCondition, {
  kind: "clock-jump" | "locale" | "timezone"
}>
type TimingCondition = Extract<ExperimentCondition, {
  kind: "event-loop-stall" | "network-delay" | "resource-loading-delay" | "startup-event-delay"
}>
type VisualCondition = Extract<ExperimentCondition, {
  kind: "animation-speed" | "reduced-motion" | "viewport"
}>
type RunnerCondition = Extract<ExperimentCondition, {
  kind: "shared-state-interference" | "worker-pressure"
}>

function isStateCondition(condition: ExperimentCondition): condition is StateCondition {
  return condition.kind === "auth-cookie-expiry" || condition.kind === "storage-state-delay"
}

function stateConditionLabel(condition: StateCondition): string {
  if (condition.kind === "auth-cookie-expiry") {
    return `Cookie ${condition.cookieName} withheld`
  }
  return `${condition.storage} key ${condition.key} hidden for ${condition.delayMs} ms`
}

function isTemporalCondition(condition: ExperimentCondition): condition is TemporalCondition {
  return condition.kind === "clock-jump"
    || condition.kind === "locale"
    || condition.kind === "timezone"
}

function temporalConditionLabel(condition: TemporalCondition): string {
  if (condition.kind === "clock-jump") {
    return `Clock shifted ${condition.offsetMs} ms after ${condition.jumpAfterMs} ms`
  }
  return condition.kind === "locale"
    ? `Locale set to ${condition.locale}`
    : `Timezone set to ${condition.timezoneId}`
}

function isTimingCondition(condition: ExperimentCondition): condition is TimingCondition {
  return condition.kind === "event-loop-stall"
    || condition.kind === "network-delay"
    || condition.kind === "resource-loading-delay"
    || condition.kind === "startup-event-delay"
}

function timingConditionLabel(condition: TimingCondition): string {
  if (condition.kind === "event-loop-stall") {
    return `Event loop stalled ${condition.durationMs} ms after ${condition.startAfterMs} ms`
  }
  if (condition.kind === "network-delay") {
    return `Network delayed by ${condition.delayMs} ms`
  }
  return condition.kind === "resource-loading-delay"
    ? `${condition.resourceType} loading delayed by ${condition.delayMs} ms`
    : `${condition.event} listeners delayed by ${condition.delayMs} ms`
}

function isVisualCondition(condition: ExperimentCondition): condition is VisualCondition {
  return condition.kind === "animation-speed"
    || condition.kind === "reduced-motion"
    || condition.kind === "viewport"
}

function visualConditionLabel(condition: VisualCondition): string {
  if (condition.kind === "animation-speed") {
    return `Animation speed set to ${condition.rate}x`
  }
  return condition.kind === "reduced-motion"
    ? "Reduced motion enabled"
    : `Viewport set to ${condition.width}x${condition.height}`
}

function runnerConditionLabel(condition: RunnerCondition): string {
  return condition.kind === "worker-pressure"
    ? `Worker pressure set to ${condition.workers} parallel workers`
    : `Shared-state interference from ${condition.copies} overlapping copies`
}

function responseConditionLabel(condition: Extract<ExperimentCondition, {
  kind: "response-duplication" | "response-reordering" | "response-truncation"
}>): string {
  if (condition.kind === "response-duplication") {
    return `Response tail duplicated by ${condition.duplicateBytes} bytes`
  }
  return condition.kind === "response-reordering"
    ? `First response in each pair held by ${condition.holdMs} ms`
    : `Response truncated by ${condition.removeBytes} bytes`
}

function conditionLabel(condition: ExperimentCondition): string {
  if (condition.kind === "baseline") {
    return "Clean baseline"
  }
  if (isStateCondition(condition)) {
    return stateConditionLabel(condition)
  }
  if (isTemporalCondition(condition)) {
    return temporalConditionLabel(condition)
  }
  if (isTimingCondition(condition)) {
    return timingConditionLabel(condition)
  }
  if (isVisualCondition(condition)) {
    return visualConditionLabel(condition)
  }
  if (condition.kind === "worker-pressure" || condition.kind === "shared-state-interference") {
    return runnerConditionLabel(condition)
  }
  if (condition.kind === "request-failure") {
    return `HTTP ${condition.statusCode} response injected`
  }
  return responseConditionLabel(condition)
}

function cleanResult(result: {
  errors: number
  failed: number
  failureRate: number
  lowerBound80: number
  passed: number
  trials: number
}): {
  errors: number
  failed: number
  failureRate: number
  lowerBound80: number
  passed: number
  trials: number
} {
  return {
    errors: result.errors,
    failed: result.failed,
    failureRate: result.failureRate,
    lowerBound80: result.lowerBound80,
    passed: result.passed,
    trials: result.trials,
  }
}

function proofMatrix(proof: RepairEvidence) {
  if (proof.outcome === "candidate-invalid") return []
  return [
    { label: "Before · hostile", result: cleanResult(proof.beforeHostile) },
    { label: "After · hostile", result: cleanResult(proof.afterHostile) },
    { label: "After · clean", result: cleanResult(proof.afterControl) },
    ...proof.regressions.map((regression) => ({
      label: `Regression · ${redactText(regression.selector)}`,
      result: cleanResult(regression.result),
    })),
  ]
}

function reportStatus(proof: RepairEvidence): EvidenceReport["status"] {
  if (proof.outcome === "candidate-invalid") return "CANDIDATE_INVALID"
  return proof.patchAccepted ? "FIX_PROVEN" : "PATCH_REJECTED"
}

function proofOutcome(proof: RepairEvidence): EvidenceReport["proof"]["outcome"] {
  if (proof.outcome === "candidate-invalid") return "candidate-invalid"
  if (proof.outcome === "candidate-proven" || proof.outcome === "candidate-rejected") {
    return proof.outcome
  }
  return proof.patchAccepted ? "candidate-proven" : "candidate-rejected"
}

function reportAttempts(proof: RepairEvidence): EvidenceReport["proof"]["attempts"] {
  return (proof.candidateGeneration?.attempts ?? []).map((attempt) => ({
    artifactPaths: {
      candidate: safeReportPath(attempt.artifactPaths.candidate),
      diff: attempt.artifactPaths.diff ? safeReportPath(attempt.artifactPaths.diff) : null,
      validation: safeReportPath(attempt.artifactPaths.validation),
    },
    attempt: attempt.attempt,
    candidatePath: attempt.candidatePath ? safeReportPath(attempt.candidatePath) : null,
    diffRendered: attempt.diffRendered,
    outcome: attempt.outcome,
    rejection: attempt.rejection ? {
      code: attempt.rejection.code,
      message: redactText(attempt.rejection.message),
    } : null,
  }))
}

function reportUsage(
  investigation: InvestigationReport,
  proof: RepairEvidence,
): EvidenceReport["usage"] {
  const candidateGeneration = proof.candidateGeneration?.usage ?? {
    estimatedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  }
  return {
    investigation: investigation.usage,
    candidateGeneration,
    combined: {
      estimatedCostUsd: investigation.usage.estimatedCostUsd
        + candidateGeneration.estimatedCostUsd,
      inputTokens: investigation.usage.inputTokens + candidateGeneration.inputTokens,
      outputTokens: investigation.usage.outputTokens + candidateGeneration.outputTokens,
    },
  }
}

function artifactLinks(
  paths: ReportPaths,
  proof: RepairEvidence,
): EvidenceReport["artifacts"] {
  const links = [
    { label: "Investigation", path: safeReportPath(paths.investigation) },
    { label: "Reproducer", path: safeReportPath(paths.reproducer) },
    { label: "Proof of fix", path: safeReportPath(paths.proof) },
  ]
  if (proof.outcome !== "candidate-invalid") {
    links.splice(2, 0, { label: "Candidate patch", path: safeReportPath(paths.patch) })
  }
  links.push(...(proof.candidateGeneration?.artifactPaths ?? []).map((path, index) => ({
    label: `Candidate attempt evidence ${index + 1}`,
    path: safeReportPath(path),
  })))
  return links
}

export function buildEvidenceReport(options: BuildReportOptions): EvidenceReport {
  const { investigation, proof, reproducer } = options
  const ownership = classifyFailure(investigation)
  const controlExperimentIds = investigation.experiments
    .filter((experiment) => experiment.condition.kind === "baseline")
    .map((experiment) => experiment.id)
  const interventionExperimentIds = investigation.experiments
    .filter((experiment) => investigation.conclusionEvidenceIds.includes(experiment.id)
      && experiment.condition.kind !== "baseline")
    .map((experiment) => experiment.id)
  if (controlExperimentIds.length === 0) {
    throw new Error("Evidence report requires a clean control experiment")
  }
  if (interventionExperimentIds.length === 0) {
    throw new Error("Evidence report requires a cited intervention experiment")
  }
  return evidenceReportSchema.parse({
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    ...(options.repository ? {
      repository: { drift: "unchanged", fingerprint: options.repository.fingerprint },
    } : {}),
    status: reportStatus(proof),
    test: redactText(investigation.test),
    model: redactText(investigation.model),
    conclusion: redactText(investigation.conclusion),
    causalClaim: {
      controlExperimentIds,
      interventionExperimentIds,
    },
    ownership: {
      ...ownership,
      rationale: redactText(ownership.rationale),
    },
    trigger: {
      faults: reproducer.faults.map((fault) => ({
        ...fault,
        pattern: redactText(fault.pattern),
      })),
      minimumFailureRate: reproducer.expectedFailure.minimumRate,
      signature: reproducer.expectedFailure.signature,
    },
    hypotheses: investigation.hypotheses.map((hypothesis) => ({
      id: hypothesis.id,
      statement: redactText(hypothesis.statement),
      status: hypothesis.status,
      explanation: redactText(hypothesis.explanation),
      evidenceExperimentIds: hypothesis.evidenceExperimentIds,
    })),
    experiments: investigation.experiments.map((experiment) => ({
      id: experiment.id,
      hypothesisId: experiment.hypothesisId,
      condition: conditionLabel(experiment.condition),
      representativeRuns: experiment.result.representativeRuns.map((run) => ({
        ...run,
        artifacts: run.artifacts.map((artifact) => ({
          ...artifact,
          path: safeReportPath(artifact.path),
        })),
      })),
      result: cleanResult(experiment.result),
    })),
    replayCommand: `flakelab replay ${JSON.stringify(options.paths.reproducer)} --concurrency 1`,
    sourcePaths: investigation.sourcePaths.map(safeReportPath),
    sourceLocations: proof.sourceLocations.map((location) => ({
      line: location.line,
      path: safeReportPath(location.path),
    })),
    proof: {
      accepted: proof.patchAccepted,
      execution: proof.execution,
      outcome: proofOutcome(proof),
      attempts: reportAttempts(proof),
      resources: proof.resources,
      staticChecks: proof.staticChecks,
      matrix: proofMatrix(proof),
    },
    usage: reportUsage(investigation, proof),
    artifacts: artifactLinks(options.paths, proof),
  })
}
