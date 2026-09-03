export interface InvestigationBudgetOptions {
  maxCostUsd: number
  maxExperiments: number
  maxSeconds: number
  maxTrials: number
}

export class InvestigationBudget {
  readonly #deadline: number
  readonly #options: InvestigationBudgetOptions
  #experiments = 0
  #trials = 0

  constructor(options: InvestigationBudgetOptions) {
    if (options.maxExperiments < 1 || options.maxTrials < 2 || options.maxSeconds < 1) {
      throw new Error("Investigation budgets must be positive")
    }
    if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
      throw new Error("Investigation cost budget must be greater than zero")
    }
    this.#options = options
    this.#deadline = Date.now() + options.maxSeconds * 1_000
  }

  reserveExperiment(trials: number): void {
    this.assertTimeRemaining()
    if (this.#experiments + 1 > this.#options.maxExperiments) {
      throw new Error("Investigation experiment budget exhausted")
    }
    if (this.#trials + trials > this.#options.maxTrials) {
      throw new Error("Investigation trial budget exhausted")
    }
    this.#experiments += 1
    this.#trials += trials
  }

  assertTimeRemaining(): void {
    if (Date.now() >= this.#deadline) {
      throw new Error("Investigation time budget exhausted")
    }
  }

  remainingMs(): number {
    return Math.max(1, this.#deadline - Date.now())
  }

  maxCostUsd(): number {
    return this.#options.maxCostUsd
  }
}
