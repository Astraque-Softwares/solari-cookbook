import { SolariError as BrowserSolariError } from "@solarisdk/browser"
import {
  ConnectionError,
  GatewayError,
  TimeoutError,
} from "@solarisdk/sandbox"
import { APICallError, RetryError } from "ai"
import { z } from "zod"

export type ProviderName = "Groq" | "Solari"
export type ProviderFailureCategory =
  | "authentication"
  | "billing"
  | "capacity"
  | "concurrency"
  | "configuration"
  | "network"
  | "permission"
  | "rate-limit"
  | "request"
  | "timeout"
  | "unavailable"

interface ProviderFailureOptions {
  action: string
  category: ProviderFailureCategory
  provider: ProviderName
  retryable: boolean
  status?: number
}

const groqErrorSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    type: z.string().optional(),
  }),
})

const solariErrorSchema = z.object({
  code: z.string().optional(),
})

export class ProviderFailure extends Error {
  readonly action: string
  readonly category: ProviderFailureCategory
  readonly provider: ProviderName
  readonly retryable: boolean
  readonly status?: number

  constructor(message: string, options: ProviderFailureOptions) {
    super(message)
    this.name = "ProviderFailure"
    this.action = options.action
    this.category = options.category
    this.provider = options.provider
    this.retryable = options.retryable
    this.status = options.status
  }
}

function failure(
  provider: ProviderName,
  category: ProviderFailureCategory,
  message: string,
  action: string,
  status?: number,
  retryable = false,
): ProviderFailure {
  return new ProviderFailure(message, { action, category, provider, retryable, status })
}

function parseGroqCode(error: APICallError): string | undefined {
  if (!error.responseBody) {
    return undefined
  }
  try {
    const parsed = groqErrorSchema.safeParse(JSON.parse(error.responseBody))
    return parsed.success ? parsed.data.error.code : undefined
  } catch {
    return undefined
  }
}

const GROQ_STATUS_FAILURES = new Map<number, () => ProviderFailure>([
  [401, () => failure("Groq", "authentication", "Groq rejected the configured API key.",
    "Replace GROQ_API_KEY or rerun with --prompt-credentials.", 401)],
  [403, () => failure("Groq", "permission", "Groq denied access to the requested model.",
    "Enable the model for the Groq project or choose an allowed model.", 403)],
  [404, () => failure("Groq", "configuration", "The configured Groq model is unavailable.",
    "Check --model and the models enabled for the Groq project.", 404)],
  [408, () => failure("Groq", "timeout", "The Groq request timed out.",
    "Rerun the investigation; increase --max-seconds only if necessary.", 408, true)],
  [413, () => failure("Groq", "request", "The Groq request exceeded the provider payload limit.",
    "Reduce the selected source context before rerunning.", 413)],
  [429, () => failure("Groq", "rate-limit", "The Groq project reached a request or token limit.",
    "Wait for the limit to reset or raise the project limit, then rerun.", 429, true)],
  [498, () => failure("Groq", "capacity", "Groq Flex capacity is temporarily unavailable.",
    "Retry later or use the default service tier.", 498, true)],
  [499, () => failure("Groq", "timeout", "The Groq request was cancelled.",
    "Rerun the investigation when ready.", 499, true)],
])

function groqCodeFailure(code: string | undefined, status?: number): ProviderFailure | undefined {
  if (code === "invalid_api_key") {
    return GROQ_STATUS_FAILURES.get(401)?.() ?? failure("Groq", "authentication",
      "Groq rejected the configured API key.",
      "Replace GROQ_API_KEY or rerun with --prompt-credentials.", status)
  }
  if (code === "capacity_exceeded") {
    return failure("Groq", "capacity", "Groq Flex capacity is temporarily unavailable.",
      "Retry later or use the default service tier.", status, true)
  }
  if (code === "blocked_api_access") {
    return failure("Groq", "billing", "Groq API access is blocked by the organization spend limit.",
      "Review the Groq organization billing limit before rerunning.", status)
  }
  return undefined
}

function mapGroqError(error: APICallError): ProviderFailure {
  const status = error.statusCode
  const codeFailure = groqCodeFailure(parseGroqCode(error), status)
  if (codeFailure) {
    return codeFailure
  }
  const knownStatus = status ? GROQ_STATUS_FAILURES.get(status) : undefined
  if (knownStatus) {
    return knownStatus()
  }
  if (status === 400 || status === 422 || status === 424) {
    return failure("Groq", "request", "Groq rejected the investigation request.",
      "Check the selected model and request configuration.", status)
  }
  if (error.isRetryable) {
    return failure("Groq", "unavailable", "Groq could not complete the investigation request.",
      "Retry after a short delay.", status, true)
  }
  return failure("Groq", "request", "Groq could not complete the investigation request.",
    "Check the Groq project and model settings.", status)
}

const SOLARI_STATUS_FAILURES = new Map<number, () => ProviderFailure>([
  [401, () => failure("Solari", "authentication", "Solari rejected the configured API key.",
    "Replace SOLARI_API_KEY or rerun with --prompt-credentials.", 401)],
  [402, () => failure("Solari", "permission", "The Solari plan does not allow this operation.",
    "Review the account plan and enabled products in the Solari console.", 402)],
  [403, () => failure("Solari", "permission", "The Solari plan does not allow this operation.",
    "Review the account plan and enabled products in the Solari console.", 403)],
  [409, () => failure("Solari", "configuration", "A Solari resource is not ready for this operation.",
    "Resolve the template, snapshot, or idempotency conflict before rerunning.", 409)],
  [429, () => failure("Solari", "concurrency", "The Solari account is at its concurrent-session cap.",
    "Wait for, pause, or kill an existing session before rerunning.", 429)],
  [501, () => failure("Solari", "configuration", "The requested Solari feature is not configured.",
    "Choose a supported feature or contact Solari support.", 501)],
])

function solariGatewayFailure(status: number, code?: string): ProviderFailure {
  if (code === "InsufficientCredit") {
    return failure("Solari", "billing", "The Solari account has insufficient prepaid credit.",
      "Add credit in the Solari console before requesting isolated proof.", status)
  }
  if (code === "ConcurrencyLimitExceeded") {
    return failure("Solari", "concurrency", "The Solari account is at its concurrent-session cap.",
      "Wait for, pause, or kill an existing session before rerunning.", status)
  }
  if (code === "BrowserUnhealthy") {
    return failure("Solari", "unavailable", "The allocated Solari browser failed its health check.",
      "Rerun once; the browser SDK will allocate a fresh session.", status || undefined, true)
  }
  if (status === 502 || status === 503 || status === 504) {
    return failure("Solari", "capacity", "Solari infrastructure is temporarily unavailable.",
      "Retry after a short delay; FlakeLab preserves bounded cleanup.", status, true)
  }
  const knownStatus = SOLARI_STATUS_FAILURES.get(status)
  if (knownStatus) {
    return knownStatus()
  }
  return failure("Solari", "request", "Solari rejected the isolated execution request.",
    "Check the requested resource and Solari account configuration.", status)
}

function mapSolariError(error: Error): ProviderFailure | undefined {
  if (error instanceof GatewayError) {
    return solariGatewayFailure(error.status, error.code)
  }
  if (error instanceof TimeoutError) {
    return failure("Solari", "timeout", "A Solari operation exceeded its deadline.",
      "Retry once; if it repeats, inspect Solari service health.", undefined, true)
  }
  if (error instanceof ConnectionError) {
    return failure("Solari", "network", "FlakeLab could not reach the Solari control channel.",
      "Check connectivity and rerun; no credential change is required.", undefined, true)
  }
  if (error instanceof BrowserSolariError) {
    return solariGatewayFailure(error.status ?? 0, error.code)
  }
  return undefined
}

export async function solariResponseFailure(response: Response): Promise<ProviderFailure> {
  const body = await response.text()
  let code: string | undefined
  try {
    const parsed = solariErrorSchema.safeParse(JSON.parse(body))
    code = parsed.success ? parsed.data.code : undefined
  } catch {
    code = undefined
  }
  return solariGatewayFailure(response.status, code)
}

export function normalizeProviderError(error: Error): Error {
  if (error instanceof ProviderFailure) {
    return error
  }
  if (RetryError.isInstance(error) && error.lastError instanceof Error) {
    return normalizeProviderError(error.lastError)
  }
  if (APICallError.isInstance(error)) {
    return mapGroqError(error)
  }
  const solari = mapSolariError(error)
  if (solari) return solari
  return error.cause instanceof Error ? normalizeProviderError(error.cause) : error
}

export function cliErrorMessage(error: Error): string {
  const normalized = normalizeProviderError(error)
  if (!(normalized instanceof ProviderFailure)) {
    return normalized.message
  }
  const status = normalized.status ? ` · HTTP ${normalized.status}` : ""
  return `${normalized.provider} ${normalized.category}${status}: ${normalized.message}\n${normalized.action}`
}
