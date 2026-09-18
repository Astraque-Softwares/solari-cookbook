import { expect, test } from "@playwright/test"
import { AuthError, ConcurrencyLimitError, PlanError } from "@solarisdk/sandbox"
import { APICallError } from "ai"

import {
  cliErrorMessage,
  normalizeProviderError,
  solariResponseFailure,
} from "../../src/providers/errors.js"

function groqError(statusCode: number, code: string): APICallError {
  return new APICallError({
    isRetryable: statusCode === 429 || statusCode >= 500,
    message: "provider prose must not be forwarded",
    requestBodyValues: { prompt: "private source context" },
    responseBody: JSON.stringify({ error: { code, message: "provider prose", type: "error" } }),
    statusCode,
    url: "https://api.groq.com/openai/v1/chat/completions",
  })
}

test("Groq authentication errors are safe and actionable", () => {
  const message = cliErrorMessage(groqError(401, "invalid_api_key"))

  expect(message).toContain("Groq authentication · HTTP 401")
  expect(message).toContain("--prompt-credentials")
  expect(message).not.toContain("provider prose")
  expect(message).not.toContain("private source context")
})

test("Groq spend and capacity errors retain distinct actions", () => {
  expect(cliErrorMessage(groqError(400, "blocked_api_access"))).toContain("Groq billing")
  expect(cliErrorMessage(groqError(498, "capacity_exceeded"))).toContain("Groq capacity")
})

test("Solari errors distinguish authentication, credit, and concurrency", () => {
  const auth = new AuthError("raw auth prose", { error: "raw auth prose" })
  const credit = new PlanError("raw credit prose", {
    code: "InsufficientCredit",
    error: "raw credit prose",
  })
  const concurrency = new ConcurrencyLimitError("raw cap prose", {
    code: "ConcurrencyLimitExceeded",
    error: "raw cap prose",
  })

  expect(cliErrorMessage(auth)).toContain("Solari authentication · HTTP 401")
  expect(cliErrorMessage(credit)).toContain("Solari billing · HTTP 402")
  expect(cliErrorMessage(concurrency)).toContain("Solari concurrency · HTTP 429")
  expect(cliErrorMessage(auth)).not.toContain("raw auth prose")
})

test("non-provider failures remain unchanged", () => {
  const error = new Error("local validation failed")
  expect(normalizeProviderError(error)).toBe(error)
  expect(cliErrorMessage(error)).toBe("local validation failed")
})

test("provider failures remain actionable through a domain error cause", () => {
  const provider = new APICallError({
    message: "raw provider message",
    url: "https://api.groq.com/openai/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: {},
    responseBody: "{}",
    isRetryable: true,
  })
  const wrapped = new Error("Candidate provider failed", { cause: provider })

  expect(cliErrorMessage(wrapped)).toContain("Groq rate-limit · HTTP 429")
  expect(cliErrorMessage(wrapped)).not.toContain("raw provider message")
})

test("low-level Solari responses use machine-readable error codes", async () => {
  const response = new Response(JSON.stringify({
    code: "InsufficientCredit",
    error: "account-specific provider prose",
  }), {
    headers: { "content-type": "application/json" },
    status: 402,
  })
  const error = await solariResponseFailure(response)
  const message = cliErrorMessage(error)

  expect(message).toContain("Solari billing · HTTP 402")
  expect(message).not.toContain("account-specific provider prose")
})
