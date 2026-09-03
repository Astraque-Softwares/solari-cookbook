import { randomUUID } from "node:crypto"
import type { EventWriter } from "../artifacts/ndjson.js"
import { planTrials } from "../core/plan.js"
import type {
  RunEvent,
  RunRequest,
  RunSummary,
  TrialOutcome,
  TrialPlan,
} from "../domain/schema.js"
import {
  runEventSchema,
  runRequestSchema,
  runSummarySchema,
  trialOutcomeSchema,
} from "../domain/schema.js"
import type { TrialExecutor } from "./playwright-executor.js"


export interface DiagnosticResult {
  runId: string
  summary: RunSummary
}

export interface DiagnosticOptions {
  concurrency?: number
  signal?: AbortSignal
}

type RunEventBody =
  | { type: "run.started"; request: RunRequest }
  | { type: "trial.started"; trial: TrialPlan }
  | { type: "trial.completed"; trial: TrialPlan; outcome: TrialOutcome }
  | { type: "run.completed"; summary: RunSummary }

function timestamp(): string {
  return new Date().toISOString()
}

function countFailures(trials: TrialPlan[], outcomes: TrialOutcome[], hasFault: boolean): number {
  return trials.reduce((count, trial, index) => {
    const matchesGroup = Boolean(trial.fault) === hasFault
    return matchesGroup && outcomes[index]?.status !== "passed" ? count + 1 : count
  }, 0)
}

function summarize(trials: TrialPlan[], outcomes: TrialOutcome[]): RunSummary {
  const baselineCount = trials.filter((trial) => !trial.fault).length
  const faultCount = trials.length - baselineCount
  const baselineFailures = countFailures(trials, outcomes, false)
  const faultFailures = countFailures(trials, outcomes, true)
  return runSummarySchema.parse({
    total: outcomes.length,
    passed: outcomes.filter((outcome) => outcome.status === "passed").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    errors: outcomes.filter((outcome) => outcome.status === "error").length,
    baselineFailureRate: baselineCount === 0 ? 0 : baselineFailures / baselineCount,
    faultFailureRate: faultCount === 0 ? 0 : faultFailures / faultCount,
  })
}

function event(runId: string, value: RunEventBody): RunEvent {
  return runEventSchema.parse({ ...value, runId, timestamp: timestamp() })
}

function validateConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new Error("concurrency must be an integer between 1 and 32")
  }
  return value
}

async function executeTrials(
  runId: string,
  trials: TrialPlan[],
  execute: TrialExecutor,
  writeEvent: EventWriter,
  options: DiagnosticOptions,
): Promise<{ trials: TrialPlan[]; outcomes: TrialOutcome[] }> {
  const concurrency = validateConcurrency(options.concurrency ?? 1)
  const completed = new Map<number, TrialOutcome>()
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (!options.signal?.aborted) {
      const index = nextIndex
      nextIndex += 1
      if (index >= trials.length) {
        return
      }
      const trial = trials[index]
      await writeEvent(event(runId, { type: "trial.started", trial }))
      const outcome = trialOutcomeSchema.parse(await execute(trial))
      completed.set(index, outcome)
      await writeEvent(event(runId, { type: "trial.completed", trial, outcome }))
    }
  }

  const workerCount = Math.min(concurrency, trials.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
  const indexes = [...completed.keys()].sort((left, right) => left - right)
  return {
    trials: indexes.map((index) => trials[index]),
    outcomes: indexes.map((index) => completed.get(index)).filter((outcome) => outcome !== undefined),
  }
}

export async function runLocalDiagnostics(
  input: RunRequest,
  execute: TrialExecutor,
  writeEvent: EventWriter,
  options: DiagnosticOptions = {},
): Promise<DiagnosticResult> {
  const request = runRequestSchema.parse(input)
  const runId = randomUUID()
  const trials = planTrials(request)

  await writeEvent(event(runId, { type: "run.started", request }))
  const completed = await executeTrials(runId, trials, execute, writeEvent, options)
  const summary = summarize(completed.trials, completed.outcomes)
  await writeEvent(event(runId, { type: "run.completed", summary }))
  return { runId, summary }
}
