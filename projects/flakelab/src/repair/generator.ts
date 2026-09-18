import type { LanguageModel } from "ai"
import { generateText, NoObjectGeneratedError, Output } from "ai"

import type { SafeSource } from "../investigator/safe-source.js"
import { readSafeRepairContext } from "../investigator/safe-source.js"
import type { InvestigationReport } from "../investigator/schema.js"
import {
  QWEN_INPUT_USD_PER_MILLION,
  QWEN_OUTPUT_USD_PER_MILLION,
} from "../investigator/groq.js"
import { CandidateAttemptLedger, candidateRejection } from "./candidate-artifacts.js"
import {
  validateCandidateSafety,
  validateCandidateSemantics,
} from "./policy.js"
import type { CandidatePreflight } from "./preflight.js"
import { CandidateValidationError } from "./rejection.js"
import type {
  CandidateGenerationEvidence,
  CandidateGenerationUsage,
  CandidatePatch,
  CandidateRejection,
} from "./schema.js"
import { candidatePatchSchema } from "./schema.js"

export type { CandidateGenerationUsage } from "./schema.js"

export interface CandidateProviderResult {
  candidate: CandidatePatch
  usage: CandidateGenerationUsage
}

export type CandidateProvider = (
  prompt: string,
  attempt: number,
) => Promise<CandidateProviderResult>

export interface PatchGeneratorOptions {
  artifactDirectory: string
  beforeProviderRequest?: () => void
  generate?: CandidateProvider
  investigation: InvestigationReport
  maxCostUsd: number
  maxAttempts?: number
  maxSeconds: number
  model?: LanguageModel
  onProgress?: (evidence: CandidateGenerationEvidence) => Promise<void>
  projectRoot: string
  selectedTest?: string
  signal?: AbortSignal
  sourcePaths: string[]
  validateCandidate?: (
    candidate: CandidatePatch,
    attempt: number,
  ) => Promise<CandidatePreflight>
}

export interface GeneratedCandidatePatch {
  candidate: CandidatePatch
  evidence: CandidateGenerationEvidence
  usage: CandidateGenerationUsage
}

export class CandidateProviderFailure extends Error {
  readonly usage: CandidateGenerationUsage

  constructor(message: string, usage: CandidateGenerationUsage, options?: ErrorOptions) {
    super(message, options)
    this.name = "CandidateProviderFailure"
    this.usage = usage
  }
}

export class CandidateGenerationFailure extends Error {
  readonly candidateInvalid: boolean
  readonly evidence: CandidateGenerationEvidence | undefined

  constructor(
    message: string,
    candidateInvalid: boolean,
    evidence?: CandidateGenerationEvidence,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "CandidateGenerationFailure"
    this.candidateInvalid = candidateInvalid
    this.evidence = evidence
  }
}

const BASELINE_GROQ_OUTPUT_TOKENS_PER_MINUTE = 1_000

/** Keeps one structured repair request below Groq's baseline organization OTPM ceiling. */
export function candidateOutputTokenBudget(outputTokensPerMinute: number): number {
  if (!Number.isInteger(outputTokensPerMinute) || outputTokensPerMinute < 100) {
    throw new Error("Groq output-token limit must be an integer of at least 100")
  }
  return Math.floor(outputTokensPerMinute * 0.9)
}

function estimatedCost(inputTokens: number, outputTokens: number): number {
  return (
    inputTokens * QWEN_INPUT_USD_PER_MILLION
    + outputTokens * QWEN_OUTPUT_USD_PER_MILLION
  ) / 1_000_000
}

function emptyUsage(): CandidateGenerationUsage {
  return { estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 }
}

function addUsage(
  total: CandidateGenerationUsage,
  next: CandidateGenerationUsage,
): CandidateGenerationUsage {
  const inputTokens = total.inputTokens + next.inputTokens
  const outputTokens = total.outputTokens + next.outputTokens
  return { estimatedCostUsd: estimatedCost(inputTokens, outputTokens), inputTokens, outputTokens }
}

function measuredUsage(value: {
  inputTokens?: number
  outputTokens?: number
}): CandidateGenerationUsage {
  const inputTokens = value.inputTokens ?? 0
  const outputTokens = value.outputTokens ?? 0
  return { estimatedCostUsd: estimatedCost(inputTokens, outputTokens), inputTokens, outputTokens }
}

function patchPrompt(investigation: InvestigationReport, sources: SafeSource[]): string {
  return [
    "Propose the smallest application-code repair for this experimentally confirmed failure.",
    "Do not edit the selected test, assertions, test configuration, or dependency configuration.",
    "Do not increase timeouts or numeric timing thresholds, add sleeps, or add retries merely to hide the failure.",
    "Do not weaken tests or assertions, skip errors, add blanket catches, or disable lint rules.",
    "Prefer a structural application fix supported by the causal evidence: request lifecycle, cancellation ownership, response validation, readiness, or error handling.",
    "When control flow changes, remove obsolete timers, flags, branches, and write-only state.",
    "The resulting source must pass strict type-aware ESLint with zero warnings.",
    "Each edit must replace one exact, verbatim source substring. Prefer one cohesive edit.",
    "The repair must preserve normal behavior and make the hostile condition pass.",
    "Investigation evidence:",
    JSON.stringify(investigation, null, 2),
    "Bounded local source context:",
    ...sources.flatMap((source) => [`--- ${source.path}`, source.content]),
  ].join("\n")
}

async function requestCandidate(
  options: PatchGeneratorOptions,
  prompt: string,
  attempt: number,
): Promise<CandidateProviderResult> {
  options.beforeProviderRequest?.()
  if (options.generate) return options.generate(prompt, attempt)
  if (!options.model) throw new Error("Candidate generation requires a language model")
  try {
    const result = await generateText({
      model: options.model,
      output: Output.object({ schema: candidatePatchSchema }),
      prompt,
      maxOutputTokens: candidateOutputTokenBudget(BASELINE_GROQ_OUTPUT_TOKENS_PER_MINUTE),
      maxRetries: 0,
      timeout: { totalMs: options.maxSeconds * 1_000 },
      abortSignal: options.signal,
      temperature: attempt === 1 ? 0.2 : 0,
    })
    return { candidate: result.output, usage: measuredUsage(result.usage) }
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new CandidateProviderFailure(
        error.message,
        measuredUsage(error.usage ?? {}),
        { cause: error },
      )
    }
    throw error
  }
}

function timingCorrection(rejected: CandidateRejection): string[] {
  if (rejected.code !== "numeric-timing-increase") return []
  return [
    "Do not increase timeouts or numeric timing thresholds.",
    "Do not add sleeps.",
    "Do not add retries merely to hide the failure.",
    "Do not weaken tests or assertions.",
    "Reconsider the confirmed causal evidence.",
    "Produce a structural application fix involving request lifecycle, cancellation ownership, response validation, readiness, or error handling when supported by the approved source.",
  ]
}

function correctivePrompt(
  initialPrompt: string,
  rejected: CandidateRejection,
  candidate: CandidatePatch | null,
): string {
  return [
    initialPrompt,
    "The previous candidate was rejected before proof execution.",
    `Structured rejection code: ${rejected.code}`,
    `Rejection explanation: ${rejected.message}`,
    ...(candidate ? [`Rejected candidate: ${JSON.stringify(candidate)}`] : []),
    "Repeating the same semantic edit is invalid.",
    ...timingCorrection(rejected),
    "Return one corrected candidate that satisfies every original constraint.",
  ].join("\n")
}

interface GenerationState {
  allowedPaths: string[]
  initialPrompt: string
  ledger: CandidateAttemptLedger
  maxAttempts: number
  prompt: string
  usage: CandidateGenerationUsage
}

function causeError(error: Error): ErrorOptions {
  return { cause: error }
}

function requireCorrection(
  state: GenerationState,
  current: CandidateGenerationEvidence,
  error: CandidateValidationError,
  attempt: number,
  candidate: CandidatePatch | null,
  detail: string,
): void {
  if (attempt === state.maxAttempts) {
    const count = `${state.maxAttempts} attempt${state.maxAttempts === 1 ? "" : "s"}`
    throw new CandidateGenerationFailure(
      `Candidate generation exhausted ${count} ${detail}`,
      true,
      current,
      causeError(error),
    )
  }
  const rejected = current.finalRejection
    ?? candidateRejection(error, attempt, candidate !== null, state.maxAttempts)
  state.prompt = correctivePrompt(state.initialPrompt, rejected, candidate)
}

async function requestAttempt(
  options: PatchGeneratorOptions,
  state: GenerationState,
  attempt: number,
): Promise<CandidateProviderResult | null> {
  try {
    const generated = await requestCandidate(options, state.prompt, attempt)
    state.usage = addUsage(state.usage, generated.usage)
    return generated
  } catch (error) {
    if (!(error instanceof CandidateProviderFailure)) {
      const current = attempt > 1 ? state.ledger.snapshot(state.usage) : undefined
      throw new CandidateGenerationFailure(
        "Candidate provider failed before completing the bounded attempt",
        false,
        current,
        { cause: error instanceof Error ? error : undefined },
      )
    }
    state.usage = addUsage(state.usage, error.usage)
    const schemaError = new CandidateValidationError("schema-invalid", error.message)
    const current = await state.ledger.recordUnsafe(
      attempt,
      error.usage,
      state.usage,
      schemaError,
    )
    requireCorrection(
      state,
      current,
      schemaError,
      attempt,
      null,
      "without a schema-valid candidate",
    )
    return null
  }
}

async function safetyAttempt(
  options: PatchGeneratorOptions,
  state: GenerationState,
  generated: CandidateProviderResult,
  attempt: number,
): Promise<CandidatePatch | null> {
  try {
    return await validateCandidateSafety(
      options.projectRoot,
      options.selectedTest ?? options.investigation.test,
      state.allowedPaths,
      generated.candidate,
    )
  } catch (error) {
    const validationError = asLocalValidationError(
      error instanceof Error ? error : new Error("Candidate safety validation failed"),
    )
    const current = await state.ledger.recordUnsafe(
      attempt,
      generated.usage,
      state.usage,
      validationError,
    )
    requireCorrection(
      state,
      current,
      validationError,
      attempt,
      null,
      "without a locally valid candidate",
    )
    return null
  }
}

async function validateAttempt(
  options: PatchGeneratorOptions,
  state: GenerationState,
  candidate: CandidatePatch,
  attemptUsage: CandidateGenerationUsage,
  attempt: number,
): Promise<GeneratedCandidatePatch | null> {
  let record
  try {
    record = await state.ledger.recordCandidate(
      attempt,
      attemptUsage,
      state.usage,
      candidate,
      options.projectRoot,
    )
  } catch (error) {
    const renderError = asLocalValidationError(
      error instanceof Error ? error : new Error("Candidate diff rendering failed"),
    )
    const current = await state.ledger.recordUnsafe(
      attempt,
      attemptUsage,
      state.usage,
      renderError,
    )
    requireCorrection(
      state,
      current,
      renderError,
      attempt,
      null,
      "without a locally valid candidate",
    )
    return null
  }
  if (state.usage.estimatedCostUsd > options.maxCostUsd) {
    throw new CandidateGenerationFailure(
      `Repair generation cost $${state.usage.estimatedCostUsd.toFixed(4)} exceeded its configured budget`,
      false,
      state.ledger.snapshot(state.usage),
    )
  }
  try {
    validateCandidateSemantics(candidate)
    const preflight = await options.validateCandidate?.(candidate, attempt)
    const completed = await state.ledger.accept(record, state.usage, preflight)
    return { candidate, evidence: completed, usage: state.usage }
  } catch (error) {
    const validationError = asLocalValidationError(
      error instanceof Error ? error : new Error("Candidate local validation failed"),
    )
    const current = await state.ledger.reject(record, state.usage, validationError)
    requireCorrection(
      state,
      current,
      validationError,
      attempt,
      candidate,
      "without a locally valid candidate",
    )
    return null
  }
}

function asLocalValidationError(error: Error): CandidateValidationError {
  if (error instanceof CandidateValidationError) return error
  return new CandidateValidationError(
    "local-validation-failed",
    `Candidate local validation failed: ${error.message}`,
    undefined,
    { cause: error },
  )
}

export async function generateCandidatePatch(
  options: PatchGeneratorOptions,
): Promise<GeneratedCandidatePatch> {
  const maxAttempts = options.maxAttempts ?? 2
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) {
    throw new Error("Candidate attempt limit must be one or two")
  }
  const sources = await readSafeRepairContext(
    options.projectRoot,
    options.selectedTest ?? options.investigation.test,
    options.sourcePaths,
    JSON.stringify(options.investigation),
  )
  const initialPrompt = patchPrompt(options.investigation, sources)
  const ledger = new CandidateAttemptLedger(
    options.artifactDirectory,
    maxAttempts,
    options.onProgress,
  )
  await ledger.initialize()
  const state: GenerationState = {
    allowedPaths: sources.map((source) => source.path),
    initialPrompt,
    ledger,
    maxAttempts,
    prompt: initialPrompt,
    usage: emptyUsage(),
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await requestAttempt(options, state, attempt)
    if (!generated) continue
    const candidate = await safetyAttempt(options, state, generated, attempt)
    if (!candidate) continue
    const result = await validateAttempt(options, state, candidate, generated.usage, attempt)
    if (result) return result
  }
  throw new CandidateGenerationFailure("Candidate generation exhausted its revision budget", true)
}
