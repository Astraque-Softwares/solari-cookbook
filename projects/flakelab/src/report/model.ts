import type { ExperimentCondition, InvestigationReport } from "../investigator/schema.js"
import type { ProofOfFix } from "../repair/schema.js"
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
  proof: ProofOfFix
  reproducer: Reproducer
}

function conditionLabel(condition: ExperimentCondition): string {
  if (condition.kind === "baseline") {
    return "Clean baseline"
  }
  if (condition.kind === "network-delay") {
    return `Network delayed by ${condition.delayMs} ms`
  }
  return `HTTP ${condition.statusCode} response injected`
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

export function buildEvidenceReport(options: BuildReportOptions): EvidenceReport {
  const { investigation, proof, reproducer } = options
  const ownership = classifyFailure(investigation)
  const trigger = reproducer.faults[0]
  const matrix = [
    { label: "Before · hostile", result: cleanResult(proof.beforeHostile) },
    { label: "After · hostile", result: cleanResult(proof.afterHostile) },
    { label: "After · clean", result: cleanResult(proof.afterControl) },
    ...proof.regressions.map((regression) => ({
      label: `Regression · ${redactText(regression.selector)}`,
      result: cleanResult(regression.result),
    })),
  ]
  return evidenceReportSchema.parse({
    version: 1,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    status: proof.patchAccepted ? "FIX_PROVEN" : "PATCH_REJECTED",
    test: redactText(investigation.test),
    model: redactText(investigation.model),
    conclusion: redactText(investigation.conclusion),
    ownership: {
      ...ownership,
      rationale: redactText(ownership.rationale),
    },
    trigger: {
      kind: trigger.kind,
      pattern: redactText(trigger.pattern),
      delayMs: trigger.delayMs,
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
      result: cleanResult(experiment.result),
    })),
    proof: {
      accepted: proof.patchAccepted,
      execution: proof.execution,
      staticChecks: proof.staticChecks,
      matrix,
    },
    usage: investigation.usage,
    artifacts: [
      { label: "Investigation", path: redactText(options.paths.investigation) },
      { label: "Reproducer", path: redactText(options.paths.reproducer) },
      { label: "Candidate patch", path: redactText(options.paths.patch) },
      { label: "Proof of fix", path: redactText(options.paths.proof) },
    ],
  })
}
