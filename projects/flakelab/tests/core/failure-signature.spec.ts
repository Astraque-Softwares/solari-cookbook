import { expect, test } from "@playwright/test"

import { normalizeFailureOutput } from "../../src/runner/playwright-executor.js"

test("failure normalization removes volatile timing and source positions", () => {
  const escape = String.fromCharCode(27)
  const first = `${escape}[2KError: expect(locator).toHaveText failed\nLocator: status\nExpected: ready\nReceived: timeout\nError Context: run-a/error.md\n at x.ts:12:4\n1.2s`
  const second = `${escape}[31mError: expect(locator).toHaveText failed${escape}[39m\nLocator: status\nExpected: ready\nReceived: timeout\n at x.ts:99:8\n842ms`

  expect(normalizeFailureOutput(first)).toBe(normalizeFailureOutput(second))
})
