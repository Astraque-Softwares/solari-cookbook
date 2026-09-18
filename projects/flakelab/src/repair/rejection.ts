export const CANDIDATE_REJECTION_CODES = [
  "schema-invalid",
  "unsafe-path",
  "unapproved-source",
  "size-limit",
  "exact-before-mismatch",
  "possible-secret",
  "test-weakening",
  "numeric-timing-increase",
  "syntax-invalid",
  "typecheck-new-diagnostic",
  "lint-new-diagnostic",
  "selected-test-not-listed",
  "local-validation-failed",
] as const

export type CandidateRejectionCode = typeof CANDIDATE_REJECTION_CODES[number]

export class CandidateValidationError extends Error {
  readonly code: CandidateRejectionCode
  readonly candidatePath: string | undefined

  constructor(
    code: CandidateRejectionCode,
    message: string,
    candidatePath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "CandidateValidationError"
    this.code = code
    this.candidatePath = candidatePath
  }
}
