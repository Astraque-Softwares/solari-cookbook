import type { ExperimentResult } from "../discovery/evaluate.js"
import type {
  ExperimentCondition,
  ExperimentEvidence,
  Hypothesis,
  InvestigationReport,
} from "./schema.js"
import { investigationReportSchema } from "./schema.js"

interface UsageSummary {
  estimatedCostUsd: number
  inputTokens: number
  outputTokens: number
}

export class InvestigationLedger {
  readonly #experiments: ExperimentEvidence[] = []
  readonly #hypotheses: Hypothesis[] = []
  #conclusion: string | undefined
  #conclusionEvidenceIds: string[] = []
  #conclusionHypothesisId: string | undefined

  propose(statement: string, prediction: string): Hypothesis {
    const hypothesis: Hypothesis = {
      id: `H${this.#hypotheses.length + 1}`,
      statement,
      prediction,
      status: "proposed",
      evidenceExperimentIds: [],
      explanation: "",
    }
    this.#hypotheses.push(hypothesis)
    return hypothesis
  }

  getHypothesis(id: string): Hypothesis {
    const hypothesis = this.#hypotheses.find((candidate) => candidate.id === id)
    if (!hypothesis) {
      throw new Error(`Hypothesis ${id} does not exist`)
    }
    return hypothesis
  }

  addExperiment(
    hypothesisId: string,
    condition: ExperimentCondition,
    result: ExperimentResult,
  ): ExperimentEvidence {
    this.getHypothesis(hypothesisId)
    const evidence: ExperimentEvidence = {
      id: `E${this.#experiments.length + 1}`,
      hypothesisId,
      condition,
      result,
    }
    this.#experiments.push(evidence)
    return evidence
  }

  assess(
    hypothesisId: string,
    status: "rejected" | "confirmed",
    evidenceExperimentIds: string[],
    explanation: string,
  ): Hypothesis {
    const hypothesis = this.getHypothesis(hypothesisId)
    const evidence = this.#resolveEvidence(hypothesisId, evidenceExperimentIds)
    if (status === "confirmed" && !this.#hasCausalIntervention(evidence)) {
      throw new Error("Confirmation requires a fault that increased and confidently reproduced failure")
    }
    if (status === "rejected" && evidence.every((entry) => entry.result.confirmed)) {
      throw new Error("Rejection requires at least one experiment that did not confirm the prediction")
    }
    hypothesis.status = status
    hypothesis.evidenceExperimentIds = evidenceExperimentIds
    hypothesis.explanation = explanation
    return hypothesis
  }

  conclude(hypothesisId: string, summary: string, evidenceExperimentIds: string[]): void {
    const hypothesis = this.getHypothesis(hypothesisId)
    if (hypothesis.status !== "confirmed") {
      throw new Error("Conclusion must identify the confirmed hypothesis")
    }
    const evidence = this.#resolveEvidence(hypothesisId, evidenceExperimentIds)
    if (!evidence.some((entry) => entry.result.confirmed && entry.condition.kind !== "baseline")) {
      throw new Error("Conclusion must cite a confirmed intervention experiment")
    }
    if (!this.#describesHypothesis(summary, hypothesis.statement)) {
      throw new Error("Conclusion must describe the confirmed causal hypothesis")
    }
    this.#conclusion = summary
    this.#conclusionEvidenceIds = evidenceExperimentIds
    this.#conclusionHypothesisId = hypothesisId
  }

  buildReport(test: string, model: string, usage: UsageSummary): InvestigationReport {
    if (!this.#conclusion) {
      throw new Error("Investigator did not record a conclusion")
    }
    if (this.#hypotheses.length < 2) {
      throw new Error("Investigator must consider at least two competing hypotheses")
    }
    const confirmed = this.#hypotheses.filter((hypothesis) => hypothesis.status === "confirmed")
    if (confirmed.length !== 1 || confirmed[0]?.id !== this.#conclusionHypothesisId) {
      throw new Error("Investigator must conclude with exactly one confirmed hypothesis")
    }
    if (!this.#hypotheses.some((hypothesis) => hypothesis.status === "rejected")) {
      throw new Error("Investigator did not reject a competing hypothesis")
    }
    return investigationReportSchema.parse({
      version: 1,
      test,
      model,
      conclusion: this.#conclusion,
      conclusionHypothesisId: this.#conclusionHypothesisId,
      conclusionEvidenceIds: this.#conclusionEvidenceIds,
      hypotheses: this.#hypotheses,
      experiments: this.#experiments,
      usage,
    })
  }

  #resolveEvidence(
    hypothesisId: string | undefined,
    ids: string[],
  ): ExperimentEvidence[] {
    if (ids.length === 0) {
      throw new Error("At least one experiment ID is required")
    }
    return ids.map((id) => {
      const evidence = this.#experiments.find((candidate) => candidate.id === id)
      if (!evidence || (hypothesisId && evidence.hypothesisId !== hypothesisId)) {
        throw new Error(`Experiment ${id} is not valid evidence for this assessment`)
      }
      return evidence
    })
  }

  #hasCausalIntervention(evidence: ExperimentEvidence[]): boolean {
    const baselineRate = Math.min(
      ...this.#experiments
        .filter((entry) => entry.condition.kind === "baseline")
        .map((entry) => entry.result.failureRate),
    )
    return evidence.some((entry) =>
      entry.condition.kind !== "baseline"
      && entry.result.confirmed
      && entry.result.failureRate > baselineRate)
  }

  #describesHypothesis(summary: string, statement: string): boolean {
    const words = (value: string): Set<string> => new Set(
      value.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length >= 5),
    )
    const hypothesisWords = words(statement)
    const sharedWords = [...words(summary)].filter((word) => hypothesisWords.has(word))
    return summary.length >= 30 && sharedWords.length >= 2
  }
}
