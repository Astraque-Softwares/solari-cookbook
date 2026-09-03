export interface ResourceUsage {
  wallTimeMs: number
  trialRuntimeMs: number
  peakConcurrency: number
  sandboxesCreated: number
  sandboxesKilled: number
  browserSessionsCreated: number
  browserSessionsClosed: number
  infrastructureRetries: number
  snapshotCacheHit: boolean
}

export class ResourceUsageTracker {
  readonly #startedAt = Date.now()
  #activeTrials = 0
  #browserSessionsClosed = 0
  #browserSessionsCreated = 0
  #infrastructureRetries = 0
  #peakConcurrency = 0
  #sandboxesCreated = 0
  #sandboxesKilled = 0
  #snapshotCacheHit = false
  #trialRuntimeMs = 0

  sandboxCreated(): void {
    this.#sandboxesCreated += 1
  }

  sandboxKilled(): void {
    this.#sandboxesKilled += 1
  }

  browserCreated(): void {
    this.#browserSessionsCreated += 1
  }

  browserClosed(): void {
    this.#browserSessionsClosed += 1
  }

  retry(): void {
    this.#infrastructureRetries += 1
  }

  snapshotCacheHit(): void {
    this.#snapshotCacheHit = true
  }

  trialStarted(): number {
    this.#activeTrials += 1
    this.#peakConcurrency = Math.max(this.#peakConcurrency, this.#activeTrials)
    return Date.now()
  }

  trialCompleted(startedAt: number): void {
    this.#activeTrials -= 1
    this.#trialRuntimeMs += Date.now() - startedAt
  }

  snapshot(): ResourceUsage {
    return {
      wallTimeMs: Date.now() - this.#startedAt,
      trialRuntimeMs: this.#trialRuntimeMs,
      peakConcurrency: this.#peakConcurrency,
      sandboxesCreated: this.#sandboxesCreated,
      sandboxesKilled: this.#sandboxesKilled,
      browserSessionsCreated: this.#browserSessionsCreated,
      browserSessionsClosed: this.#browserSessionsClosed,
      infrastructureRetries: this.#infrastructureRetries,
      snapshotCacheHit: this.#snapshotCacheHit,
    }
  }
}
