export class ProviderRequestBudget {
  readonly #maximum: number
  #used = 0

  constructor(maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error("Provider request budget must be a positive integer")
    }
    this.#maximum = maximum
  }

  remaining(): number {
    return this.#maximum - this.#used
  }

  reserve(): void {
    if (this.remaining() === 0) {
      throw new Error(`Provider request budget exhausted after ${this.#maximum} calls`)
    }
    this.#used += 1
  }
}
