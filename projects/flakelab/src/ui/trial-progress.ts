import { formatDuration, formatSeconds } from "./format.js"
import type { ProgressReporter } from "./progress.js"
import type { Fault, TrialOutcome, TrialPlan } from "../domain/schema.js"

function faultParameter(fault: Fault): string {
  if ("delayMs" in fault) return `${fault.delayMs}ms`
  if ("durationMs" in fault) return `${fault.durationMs}ms`
  if ("holdMs" in fault) return `${fault.holdMs}ms`
  if ("removeBytes" in fault) return `${fault.removeBytes} bytes`
  if ("duplicateBytes" in fault) return `${fault.duplicateBytes} bytes`
  if ("workers" in fault) return `${fault.workers} workers`
  if ("copies" in fault) return `${fault.copies} copies`
  return "configured"
}

function trialRole(trial: TrialPlan): string {
  if (trial.trialId.startsWith("screen-")) return "screen"
  return trial.faults.length === 0 ? "control · no-op proxy" : "intervention"
}

function trialFault(trial: TrialPlan): string {
  const fault = trial.faults[0]
  return fault ? ` · ${fault.kind} ${faultParameter(fault)}` : ""
}

/**
 * Trial-level progress for long causal searches. One line per completed trial
 * carries the running count, the outcome, the trial duration, the pass/fail
 * split so far, and how much of the elapsed-time budget is spent. Individual
 * fault installations, browser launches, and retries stay silent.
 */
export class TrialProgress {
  #errored = 0
  #failed = 0
  #passed = 0
  readonly #budgetSeconds: number
  readonly #reporter: ProgressReporter
  readonly #startedAt = Date.now()

  constructor(reporter: ProgressReporter, budgetSeconds: number) {
    this.#budgetSeconds = budgetSeconds
    this.#reporter = reporter
  }

  get completed(): number {
    return this.#passed + this.#failed + this.#errored
  }

  trial(trial: TrialPlan, outcome: TrialOutcome): void {
    this.#count(outcome.status)
    const errors = this.#errored > 0 ? ` / ${this.#errored} errored` : ""
    const signature = outcome.failureSignature
      ? ` · signature ${outcome.failureSignature}`
      : ""
    this.#reporter.step(
      `trial ${this.completed} · ${trialRole(trial)}${trialFault(trial)}`
      + ` · ${outcome.status}${signature} · ${formatDuration(outcome.durationMs)}`
      + ` · ${this.#passed} passed / ${this.#failed} failed${errors}`
      + ` · ${formatDuration(Date.now() - this.#startedAt)} of`
      + ` ${formatSeconds(this.#budgetSeconds)}`,
    )
  }

  #count(status: string): void {
    if (status === "failed") {
      this.#failed += 1
    } else if (status === "passed") {
      this.#passed += 1
    } else {
      this.#errored += 1
    }
  }
}
