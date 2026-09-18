import { isDeepStrictEqual } from "node:util"
import { z } from "zod"

import { InvestigationLedger } from "./ledger.js"
import {
  type ModelGenerationUsage,
  RecoverableGenerationError,
  schemaCorrectionPrompt,
} from "./generation.js"
import type { ExperimentEvidence, Hypothesis } from "./schema.js"
import { hasConfirmedCausalSignal } from "./causality.js"

const assessmentItemSchema = z.object({
  hypothesisId: z.string().regex(/^H\d+$/u),
  status: z.enum(["rejected", "confirmed", "corroborating"]),
  explanation: z.string().min(8).max(1_000),
})

export const investigationAssessmentSchema = z.object({
  assessments: z.array(assessmentItemSchema).length(2),
  conclusionHypothesisId: z.string().regex(/^H\d+$/u),
  conclusion: z.string().min(30).max(2_000),
})

export type InvestigationAssessment = z.infer<typeof investigationAssessmentSchema>

export interface AssessmentGeneration {
  output: InvestigationAssessment
  usage: ModelGenerationUsage
}

interface GenerateValidAssessmentOptions {
  generate: (prompt: string, temperature: number) => Promise<AssessmentGeneration>
  initialPrompt: string
  maxAttempts: number
  temperature?: number
}

export interface ValidAssessmentResult {
  assessment: InvestigationAssessment
  attempts: ModelGenerationUsage[]
}

export async function generateValidInvestigationAssessment(
  options: GenerateValidAssessmentOptions,
): Promise<ValidAssessmentResult> {
  const attempts: ModelGenerationUsage[] = []
  let prompt = options.initialPrompt
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    try {
      const generated = await options.generate(
        prompt,
        attempt === 0 ? (options.temperature ?? 0.2) : 0,
      )
      attempts.push(generated.usage)
      return { assessment: generated.output, attempts }
    } catch (error) {
      if (!(error instanceof RecoverableGenerationError)) {
        throw error
      }
      attempts.push(error.usage)
      if (attempt + 1 >= options.maxAttempts) {
        throw error
      }
      prompt = schemaCorrectionPrompt(
        options.initialPrompt,
        error,
        "assessments (exactly 2), conclusionHypothesisId, and conclusion",
      )
    }
  }
  throw new Error("Investigation assessment generation exhausted its attempt budget")
}

export interface AssessmentState {
  evidence: ExperimentEvidence[]
  hypotheses: Hypothesis[]
  ledger: InvestigationLedger
}

export function groundAssessmentInEvidence(
  state: AssessmentState,
  assessment?: InvestigationAssessment,
  preferredCondition?: ExperimentEvidence["condition"],
): InvestigationAssessment {
  if (assessment) {
    const assessedIds = new Set(assessment.assessments.map((item) => item.hypothesisId))
    if (assessedIds.size !== state.hypotheses.length) {
      throw new Error("Investigator must assess every proposed hypothesis exactly once")
    }
  }
  const baseline = baselineEvidence(state.evidence)
  const confirmedHypothesis = primaryHypothesis(state, baseline, preferredCondition)
  return {
    assessments: state.hypotheses.map((hypothesis) => {
      const status = groundedStatus(state, baseline, hypothesis, confirmedHypothesis)
      return {
        explanation: groundedExplanation(status, hypothesis),
        hypothesisId: hypothesis.id,
        status,
      }
    }),
    conclusion: `Controlled evidence confirms this causal hypothesis: ${confirmedHypothesis.statement}`,
    conclusionHypothesisId: confirmedHypothesis.id,
  }
}

function causalEvidence(
  state: AssessmentState,
  baseline: ExperimentEvidence,
  hypothesis: Hypothesis,
): ExperimentEvidence[] {
  return state.evidence.filter((entry) =>
    entry.hypothesisId === hypothesis.id && isCausal(entry, baseline))
}

function preferredHypothesis(
  state: AssessmentState,
  baseline: ExperimentEvidence,
  preferredCondition: ExperimentEvidence["condition"],
): Hypothesis {
  const evidence = state.evidence.find((entry) =>
    entry.condition.kind !== "baseline"
    && isDeepStrictEqual(entry.condition, preferredCondition))
  if (!evidence || !isCausal(evidence, baseline)) {
    throw new Error("The discovery-confirmed intervention was not preserved as causal evidence")
  }
  const hypothesis = state.hypotheses.find((entry) => entry.id === evidence.hypothesisId)
  if (!hypothesis) {
    throw new Error("The discovery-confirmed intervention is not assigned to a hypothesis")
  }
  return hypothesis
}

function primaryHypothesis(
  state: AssessmentState,
  baseline: ExperimentEvidence,
  preferredCondition?: ExperimentEvidence["condition"],
): Hypothesis {
  if (preferredCondition) {
    return preferredHypothesis(state, baseline, preferredCondition)
  }
  const confirmed = state.hypotheses.filter((hypothesis) =>
    causalEvidence(state, baseline, hypothesis).length > 0)
  if (confirmed.length !== 1) {
    throw new Error(
      `Investigation requires one primary causal hypothesis; measured ${confirmed.length}`,
    )
  }
  return confirmed[0]
}

function groundedStatus(
  state: AssessmentState,
  baseline: ExperimentEvidence,
  hypothesis: Hypothesis,
  primary: Hypothesis,
): InvestigationAssessment["assessments"][number]["status"] {
  if (hypothesis.id === primary.id) return "confirmed"
  return causalEvidence(state, baseline, hypothesis).length > 0
    ? "corroborating"
    : "rejected"
}

function groundedExplanation(
  status: InvestigationAssessment["assessments"][number]["status"],
  hypothesis: Hypothesis,
): string {
  if (status === "confirmed") {
    return `Controlled discovery evidence confirmed this primary prediction: ${hypothesis.prediction}`
  }
  if (status === "corroborating") {
    return `Additional controlled evidence also reproduced this prediction: ${hypothesis.prediction}`
  }
  return `Controlled evidence did not confirm this prediction: ${hypothesis.prediction}`
}

function completedTrials(entry: ExperimentEvidence): number {
  return entry.result.passed + entry.result.failed
}

function evidenceError(entry: ExperimentEvidence): string | undefined {
  if (entry.result.errors > 0) {
    const reason = entry.result.dominantErrorReason
      ? `: ${entry.result.dominantErrorReason}`
      : ""
    return `Experiment ${entry.id} produced ${entry.result.errors} runner error(s) and is inconclusive${reason}`
  }
  if (entry.result.trials === 0 || completedTrials(entry) !== entry.result.trials) {
    return `Experiment ${entry.id} did not produce a complete pass/fail result and is inconclusive`
  }
  return undefined
}

export function validateExperimentEvidence(evidence: ExperimentEvidence[]): void {
  const error = evidence.map(evidenceError).find((message) => message !== undefined)
  if (error) {
    throw new Error(`${error}; repair the test runner failure before assessing causality`)
  }
}

function baselineEvidence(evidence: ExperimentEvidence[]): ExperimentEvidence {
  const baselines = evidence.filter((entry) => entry.condition.kind === "baseline")
  if (baselines.length !== 1) {
    throw new Error("Investigation requires exactly one usable baseline experiment")
  }
  return baselines[0]
}

function isCausal(entry: ExperimentEvidence, baseline: ExperimentEvidence): boolean {
  return entry.condition.kind !== "baseline"
    && hasConfirmedCausalSignal(entry.result, baseline.result.upperBound80)
}

function evidenceIdsForStatus(
  evidence: ExperimentEvidence[],
  hypothesisId: string,
  status: InvestigationAssessment["assessments"][number]["status"],
  baseline: ExperimentEvidence,
): string[] {
  const interventions = evidence.filter((entry) =>
    entry.hypothesisId === hypothesisId && entry.condition.kind !== "baseline")
  const matching = interventions.filter((entry) =>
    status === "rejected" ? !isCausal(entry, baseline) : isCausal(entry, baseline))
  if (matching.length === 0) {
    throw new Error(`Hypothesis ${hypothesisId} cannot be ${status} by the measured evidence`)
  }
  return matching.map((entry) => entry.id)
}

export function applyInvestigationAssessment(
  state: AssessmentState,
  assessment: InvestigationAssessment,
): void {
  validateExperimentEvidence(state.evidence)
  const assessedIds = new Set(assessment.assessments.map((item) => item.hypothesisId))
  if (assessedIds.size !== state.hypotheses.length) {
    throw new Error("Investigator must assess every proposed hypothesis exactly once")
  }
  const baseline = baselineEvidence(state.evidence)
  const evidenceByHypothesis = new Map<string, string[]>()
  for (const item of assessment.assessments) {
    const evidenceIds = evidenceIdsForStatus(
      state.evidence,
      item.hypothesisId,
      item.status,
      baseline,
    )
    evidenceByHypothesis.set(item.hypothesisId, evidenceIds)
    state.ledger.assess(item.hypothesisId, item.status, evidenceIds, item.explanation)
  }
  const conclusionEvidence = evidenceByHypothesis.get(assessment.conclusionHypothesisId)
  if (!conclusionEvidence) {
    throw new Error("Conclusion must identify an assessed hypothesis")
  }
  state.ledger.conclude(
    assessment.conclusionHypothesisId,
    assessment.conclusion,
    conclusionEvidence,
  )
}
