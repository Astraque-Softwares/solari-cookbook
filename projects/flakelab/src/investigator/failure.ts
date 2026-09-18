import type { ExperimentEvidence, Hypothesis } from "./schema.js"

export interface PartialInvestigation {
  experiments: ExperimentEvidence[]
  hypotheses: Hypothesis[]
  usage: {
    estimatedCostUsd: number
    inputTokens: number
    outputTokens: number
  }
}

export class InvestigationFailure extends Error {
  readonly partial: PartialInvestigation

  constructor(message: string, partial: PartialInvestigation, cause?: Error) {
    super(message, cause ? { cause } : undefined)
    this.name = "InvestigationFailure"
    this.partial = partial
  }
}
