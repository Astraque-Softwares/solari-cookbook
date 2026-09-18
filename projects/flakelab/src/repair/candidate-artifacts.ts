import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { redactText } from "../report/redaction.js"
import type { CandidatePreflight } from "./preflight.js"
import type { CandidateValidationError } from "./rejection.js"
import type {
  CandidateAttempt,
  CandidateGenerationEvidence,
  CandidateGenerationUsage,
  CandidatePatch,
  CandidateRejection,
} from "./schema.js"
import { candidateGenerationEvidenceSchema } from "./schema.js"
import { createCandidateDiff } from "./workspace.js"

type ProgressCallback = (evidence: CandidateGenerationEvidence) => Promise<void>

export function candidateRejection(
  error: CandidateValidationError,
  attempt: number,
  diffRendered: boolean,
  maxAttempts = 2,
): CandidateRejection {
  return {
    attempt,
    ...(error.candidatePath ? { candidatePath: error.candidatePath } : {}),
    code: error.code,
    correctiveAttemptPermitted: attempt < maxAttempts,
    diffRendered,
    message: redactText(error.message).slice(0, 2_000),
  }
}

function attemptPaths(directory: string, attempt: number): CandidateAttempt["artifactPaths"] {
  return {
    candidate: resolve(directory, `attempt-${attempt}.json`),
    diff: resolve(directory, `attempt-${attempt}.diff`),
    validation: resolve(directory, `attempt-${attempt}.validation.json`),
  }
}

async function writeValidation(
  record: CandidateAttempt,
  preflight?: CandidatePreflight,
): Promise<void> {
  await writeFile(
    record.artifactPaths.validation,
    `${JSON.stringify({
      attempt: record.attempt,
      diffRendered: record.diffRendered,
      outcome: record.outcome,
      rejection: record.rejection,
      ...(preflight ? { preflight } : {}),
    }, null, 2)}\n`,
    "utf8",
  )
}

async function writeAttempt(
  record: CandidateAttempt,
  candidate: CandidatePatch | null,
): Promise<void> {
  await writeFile(
    record.artifactPaths.candidate,
    `${JSON.stringify({
      attempt: record.attempt,
      candidate,
      retention: candidate ? "safe-candidate" : "safe-metadata-only",
      usage: record.usage,
    }, null, 2)}\n`,
    "utf8",
  )
  await writeValidation(record)
}

function invalidRecord(
  attempt: number,
  usage: CandidateGenerationUsage,
  error: CandidateValidationError,
  paths: CandidateAttempt["artifactPaths"],
  diffRendered: boolean,
  maxAttempts: number,
): CandidateAttempt {
  const detail = candidateRejection(error, attempt, diffRendered, maxAttempts)
  return {
    artifactPaths: { ...paths, diff: diffRendered ? paths.diff : null },
    attempt,
    candidatePath: detail.candidatePath ?? null,
    diffRendered,
    outcome: "candidate-invalid",
    rejection: detail,
    usage,
  }
}

export class CandidateAttemptLedger {
  readonly #attempts: CandidateAttempt[] = []
  readonly #directory: string
  readonly #maxAttempts: number
  readonly #onProgress: ProgressCallback | undefined

  constructor(directory: string, maxAttempts: number, onProgress?: ProgressCallback) {
    this.#directory = directory
    this.#maxAttempts = maxAttempts
    this.#onProgress = onProgress
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true })
  }

  snapshot(usage: CandidateGenerationUsage): CandidateGenerationEvidence {
    const last = this.#attempts.at(-1)
    return candidateGenerationEvidenceSchema.parse({
      artifactPaths: this.#attempts.flatMap((entry) => [
        entry.artifactPaths.candidate,
        ...(entry.artifactPaths.diff ? [entry.artifactPaths.diff] : []),
        entry.artifactPaths.validation,
      ]),
      attemptCount: this.#attempts.length,
      attempts: this.#attempts,
      correctiveAttemptOccurred: this.#attempts.length > 1,
      finalRejection: last?.rejection ?? null,
      usage,
    })
  }

  async recordUnsafe(
    attempt: number,
    attemptUsage: CandidateGenerationUsage,
    totalUsage: CandidateGenerationUsage,
    error: CandidateValidationError,
  ): Promise<CandidateGenerationEvidence> {
    const record = invalidRecord(
      attempt,
      attemptUsage,
      error,
      attemptPaths(this.#directory, attempt),
      false,
      this.#maxAttempts,
    )
    this.#attempts.push(record)
    await writeAttempt(record, null)
    return this.#publish(totalUsage)
  }

  async recordCandidate(
    attempt: number,
    attemptUsage: CandidateGenerationUsage,
    totalUsage: CandidateGenerationUsage,
    candidate: CandidatePatch,
    projectRoot: string,
  ): Promise<CandidateAttempt> {
    const paths = attemptPaths(this.#directory, attempt)
    const diff = await createCandidateDiff(projectRoot, candidate)
    if (!paths.diff) throw new Error("Safe candidate diff path is missing")
    await writeFile(paths.diff, diff, "utf8")
    const record: CandidateAttempt = {
      artifactPaths: paths,
      attempt,
      candidatePath: candidate.edits[0]?.path ?? null,
      diffRendered: true,
      outcome: "pending",
      rejection: null,
      usage: attemptUsage,
    }
    this.#attempts.push(record)
    await writeAttempt(record, candidate)
    await this.#publish(totalUsage)
    return record
  }

  async reject(
    record: CandidateAttempt,
    totalUsage: CandidateGenerationUsage,
    error: CandidateValidationError,
  ): Promise<CandidateGenerationEvidence> {
    const rejected = invalidRecord(
      record.attempt,
      record.usage,
      error,
      record.artifactPaths,
      true,
      this.#maxAttempts,
    )
    this.#attempts[this.#attempts.length - 1] = rejected
    await writeValidation(rejected)
    return this.#publish(totalUsage)
  }

  async accept(
    record: CandidateAttempt,
    totalUsage: CandidateGenerationUsage,
    preflight?: CandidatePreflight,
  ): Promise<CandidateGenerationEvidence> {
    record.outcome = "valid"
    await writeValidation(record, preflight)
    return this.#publish(totalUsage)
  }

  async #publish(usage: CandidateGenerationUsage): Promise<CandidateGenerationEvidence> {
    const current = this.snapshot(usage)
    await this.#onProgress?.(current)
    return current
  }
}
