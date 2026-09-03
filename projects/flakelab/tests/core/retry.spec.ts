import { expect, test } from "@playwright/test"
import { NoCapacityError } from "@solarisdk/sandbox"

import { retryTransient } from "../../src/solari/retry.js"

test("transient Solari capacity failures are retried within the bound", async () => {
  let attempts = 0
  let retries = 0
  const result = await retryTransient(() => {
    attempts += 1
    if (attempts < 3) {
      return Promise.reject(new NoCapacityError("temporary capacity shortage"))
    }
    return Promise.resolve("ready")
  }, {
    attempts: 3,
    baseDelayMs: 0,
    onRetry: () => {
      retries += 1
    },
  })

  expect(result).toBe("ready")
  expect(attempts).toBe(3)
  expect(retries).toBe(2)
})

test("non-transient failures are not retried", async () => {
  let attempts = 0
  await expect(retryTransient(() => {
    attempts += 1
    return Promise.reject(new Error("invalid configuration"))
  }, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow("invalid configuration")
  expect(attempts).toBe(1)
})

test("transport fetch failures are retried", async () => {
  let attempts = 0
  const result = await retryTransient(() => {
    attempts += 1
    return attempts === 1
      ? Promise.reject(new TypeError("fetch failed"))
      : Promise.resolve("connected")
  }, { attempts: 2, baseDelayMs: 0 })

  expect(result).toBe("connected")
  expect(attempts).toBe(2)
})
