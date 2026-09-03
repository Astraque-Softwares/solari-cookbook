import { SolariError as BrowserSolariError } from "@solarisdk/browser"
import {
  ConnectionError,
  GatewayError,
  NoCapacityError,
  TimeoutError,
} from "@solarisdk/sandbox"

import { setTimeout as delay } from "node:timers/promises"

export interface RetryOptions {
  attempts: number
  baseDelayMs: number
  signal?: AbortSignal
  onRetry?: () => void
}

function isRetryable(error: Error): boolean {
  if (error instanceof TypeError && error.message === "fetch failed") {
    return true
  }
  if (error instanceof NoCapacityError || error instanceof TimeoutError) {
    return true
  }
  if (error instanceof ConnectionError) {
    return true
  }
  if (error instanceof GatewayError) {
    return error.status >= 500
  }
  if (error instanceof BrowserSolariError) {
    return error.status === 502 || error.status === 503
  }
  return false
}

function validateRetryOptions(options: RetryOptions): void {
  if (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > 5) {
    throw new Error("retry attempts must be an integer between 1 and 5")
  }
}

function shouldRetry(error: Error, attempt: number, attempts: number): boolean {
  return isRetryable(error) && attempt < attempts
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  validateRetryOptions(options)

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    options.signal?.throwIfAborted()
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error
      }
      if (!shouldRetry(error, attempt, options.attempts)) {
        throw error
      }
      options.onRetry?.()
      await delay(options.baseDelayMs * attempt, undefined, { signal: options.signal })
    }
  }
  throw new Error("retry loop completed without a result")
}
