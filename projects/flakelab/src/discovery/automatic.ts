import { deriveTrialSeed } from "../core/plan.js"
import type { Fault, TrialOutcome, TrialPlan } from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"

export const AUTOMATIC_FAULT = "auto"

export interface AutomaticScreeningCapabilities {
  scan?: {
    clean: boolean
    executions: number
    workers: number
  }
  selectedTestCount: number
}

export interface AutomaticFaultOptions {
  animationRate: number
  capabilities: AutomaticScreeningCapabilities
  concurrency: number
  clockOffsetMs: number
  eventLoopDurationMs: number
  holdMs: number
  locale: string
  maximumDelayMs: number
  maximumDuplicateBytes: number
  maximumRemoveBytes: number
  pattern: string
  seed: number
  selector: string
  signal?: AbortSignal
  startupEvent: "dom-content-loaded" | "load"
  timezoneId: string
  viewportHeight: number
  viewportWidth: number
}

export type AutomaticScreeningCoverage =
  | "covered-by-scan"
  | "not-applicable"
  | "not-run"
  | "screened"

export interface AutomaticFaultScreening {
  coverage: AutomaticScreeningCoverage
  errors: number
  failed: number
  fault: Fault
  passed: number
  reason: string
  signatures: string[]
  trials: number
}

export interface AutomaticFaultSelection {
  fault: Fault
  screenings: AutomaticFaultScreening[]
}

export interface AutomaticFaultCandidateNotice {
  coverage: Exclude<AutomaticScreeningCoverage, "not-run" | "screened"> | "scheduled"
  kind: Fault["kind"]
  reason: string
}

export class NoAutomaticFaultSignalError extends Error {
  readonly screenings: AutomaticFaultScreening[]

  constructor(screenings: AutomaticFaultScreening[]) {
    const attempted = screenings
      .filter((entry) => entry.coverage === "screened")
      .map((entry) => entry.fault.kind)
      .join(", ")
    super(`No fault signal was observed in the bounded screen (${attempted})`)
    this.name = "NoAutomaticFaultSignalError"
    this.screenings = screenings
  }
}

interface AutomaticFaultCandidate {
  coverage: "covered-by-scan" | "not-applicable" | "scheduled"
  fault: Fault
  reason: string
}

interface ScreeningTrial {
  candidateIndex: number
  outcome: TrialOutcome
}

const VISUAL_CLUES = /animation|canvas|layout|mobile|motion|responsive|screenshot|visual|viewport/iu
const TEMPORAL_CLUES = /calendar|clock|date|locale|time|timezone/iu

function scheduled(fault: Fault, reason: string): AutomaticFaultCandidate {
  return { coverage: "scheduled", fault, reason }
}

function requestCandidates(options: AutomaticFaultOptions): AutomaticFaultCandidate[] {
  const reason = `Observed application request matched ${options.pattern}.`
  return [
    scheduled({
      delayMs: options.maximumDelayMs,
      kind: "network-delay",
      pattern: options.pattern,
    }, reason),
    scheduled({
      kind: "response-truncation",
      pattern: options.pattern,
      removeBytes: options.maximumRemoveBytes,
    }, reason),
    scheduled({
      duplicateBytes: options.maximumDuplicateBytes,
      kind: "response-duplication",
      pattern: options.pattern,
    }, reason),
    scheduled({
      holdMs: options.holdMs,
      kind: "response-reordering",
      pattern: options.pattern,
    }, reason),
  ]
}

function scanCoversRunnerOverlap(capabilities: AutomaticScreeningCapabilities): boolean {
  const scan = capabilities.scan
  return scan !== undefined && scan.clean && scan.executions >= 2 && scan.workers >= 2
}

function runnerCandidates(options: AutomaticFaultOptions): AutomaticFaultCandidate[] {
  const workerFault: Fault = {
    kind: "worker-pressure",
    pattern: options.selector,
    workers: 4,
  }
  const sharedFault: Fault = {
    copies: 4,
    kind: "shared-state-interference",
    pattern: options.selector,
  }
  const worker = options.capabilities.selectedTestCount > 1
    ? scheduled(workerFault, "Multiple resolved tests can occupy parallel Playwright workers.")
    : {
        coverage: "not-applicable" as const,
        fault: workerFault,
        reason: "One resolved test cannot occupy multiple Playwright workers without repetition.",
      }
  const shared = scanCoversRunnerOverlap(options.capabilities)
    ? {
        coverage: "covered-by-scan" as const,
        fault: sharedFault,
        reason: "The clean repeated scan already overlapped executions across multiple workers.",
      }
    : scheduled(sharedFault, "No clean multi-worker repeated scan covers shared-state overlap.")
  return [worker, shared]
}

function runtimeCandidates(options: AutomaticFaultOptions): AutomaticFaultCandidate[] {
  return [
    scheduled({
      delayMs: options.maximumDelayMs,
      event: options.startupEvent,
      kind: "startup-event-delay",
      pattern: "**",
    }, "The selected test exercises a browser document."),
    scheduled({
      durationMs: options.eventLoopDurationMs,
      kind: "event-loop-stall",
      pattern: "**",
      startAfterMs: 0,
    }, "The selected test executes in a browser page."),
    ...runnerCandidates(options),
  ]
}

function semanticCandidates(options: AutomaticFaultOptions): AutomaticFaultCandidate[] {
  const candidates: AutomaticFaultCandidate[] = []
  if (VISUAL_CLUES.test(options.selector)) {
    const reason = "The selected test identity contains visual or responsive clues."
    candidates.push(
      scheduled({
        height: options.viewportHeight,
        kind: "viewport",
        pattern: "**",
        width: options.viewportWidth,
      }, reason),
      scheduled({ kind: "reduced-motion", pattern: "**" }, reason),
      scheduled({ kind: "animation-speed", pattern: "**", rate: options.animationRate }, reason),
    )
  }
  if (TEMPORAL_CLUES.test(options.selector)) {
    const reason = "The selected test identity contains temporal or localization clues."
    candidates.push(
      scheduled({
        jumpAfterMs: 0,
        kind: "clock-jump",
        offsetMs: options.clockOffsetMs,
        pattern: "**",
      }, reason),
      scheduled({ kind: "locale", locale: options.locale, pattern: "**" }, reason),
      scheduled({ kind: "timezone", pattern: "**", timezoneId: options.timezoneId }, reason),
    )
  }
  return candidates
}

function automaticFaultPlan(options: AutomaticFaultOptions): AutomaticFaultCandidate[] {
  return [
    ...semanticCandidates(options),
    ...requestCandidates(options),
    ...runtimeCandidates(options),
  ]
}

export function automaticFaultCandidates(options: AutomaticFaultOptions): Fault[] {
  return automaticFaultPlan(options).map((candidate) => candidate.fault)
}

export function automaticScreeningTrialBound(
  selector: string,
  capabilities: AutomaticScreeningCapabilities = { selectedTestCount: 1 },
): number {
  let trials = 6
  if (VISUAL_CLUES.test(selector)) trials += 3
  if (TEMPORAL_CLUES.test(selector)) trials += 3
  if (capabilities.selectedTestCount > 1) trials += 1
  if (!scanCoversRunnerOverlap(capabilities)) trials += 1
  return trials
}

async function executeScreening(
  execute: TrialExecutor,
  plans: Array<{ candidateIndex: number; plan: TrialPlan }>,
  signal?: AbortSignal,
): Promise<ScreeningTrial[]> {
  const completed: ScreeningTrial[] = []
  for (const entry of plans) {
    if (signal?.aborted) break
    const outcome = await execute(entry.plan)
    completed.push({ candidateIndex: entry.candidateIndex, outcome })
    if (outcome.status === "failed") break
  }
  if (signal?.aborted) {
    const error = new Error("Automatic fault screening was interrupted")
    error.name = "AbortError"
    throw error
  }
  return completed
}

function outcomeSummary(
  candidate: AutomaticFaultCandidate,
  outcomes: TrialOutcome[],
): AutomaticFaultScreening {
  let coverage: AutomaticScreeningCoverage
  if (candidate.coverage === "scheduled") {
    coverage = outcomes.length > 0 ? "screened" : "not-run"
  } else {
    coverage = candidate.coverage
  }
  const reason = coverage === "not-run"
    ? "Screening stopped after another family produced a signal or runner error."
    : candidate.reason
  return {
    coverage,
    errors: outcomes.filter((outcome) => outcome.status === "error").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    fault: candidate.fault,
    passed: outcomes.filter((outcome) => outcome.status === "passed").length,
    reason,
    signatures: [...new Set(outcomes.flatMap((outcome) =>
      outcome.failureSignature ? [outcome.failureSignature] : []))],
    trials: outcomes.length,
  }
}

function screeningError(screenings: AutomaticFaultScreening[]): Error | undefined {
  const errored = screenings.filter((entry) => entry.errors > 0)
  if (errored.length === 0) return undefined
  const details = errored.map((entry) => `${entry.fault.kind}: ${entry.errors}`).join(", ")
  return new Error(`Automatic fault screening encountered runner errors (${details})`)
}

export async function selectAutomaticFault(
  execute: TrialExecutor,
  options: AutomaticFaultOptions,
  onCandidate?: (candidate: AutomaticFaultCandidateNotice) => void,
): Promise<AutomaticFaultSelection> {
  const candidates = automaticFaultPlan(options)
  for (const candidate of candidates) {
    onCandidate?.({
      coverage: candidate.coverage,
      kind: candidate.fault.kind,
      reason: candidate.reason,
    })
  }
  const planned = candidates.flatMap((candidate, candidateIndex) =>
    candidate.coverage === "scheduled" ? [{
      candidateIndex,
      plan: {
        faults: [candidate.fault],
        index: candidateIndex,
        seed: deriveTrialSeed(options.seed, candidateIndex),
        trialId: `screen-${candidate.fault.kind}`,
      },
    }] : [])
  const completed = await executeScreening(execute, planned, options.signal)
  const screenings = candidates.map((candidate, index) => outcomeSummary(
    candidate,
    completed.filter((entry) => entry.candidateIndex === index).map((entry) => entry.outcome),
  ))
  const selected = screenings.find((entry) => entry.failed > 0)
  if (selected) return { fault: selected.fault, screenings }
  const error = screeningError(screenings)
  if (error) throw error
  const notRun = screenings.filter((entry) => entry.coverage === "not-run")
  if (notRun.length > 0) {
    throw new Error("Automatic fault screening ended before every applicable probe completed")
  }
  throw new NoAutomaticFaultSignalError(screenings)
}
