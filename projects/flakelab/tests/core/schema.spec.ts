import { expect, test } from "@playwright/test"

import { runRequestSchema } from "../../src/domain/schema.js"

const validRequest = {
  selector: "tests/checkout.spec.ts",
  runs: 4,
  seed: 42,
  artifactDirectory: ".flakelab/runs",
  fault: {
    kind: "network-delay" as const,
    pattern: "**/api/checkout",
    delayMs: 250,
  },
}

test("run schema accepts a bounded deterministic diagnosis", () => {
  expect(runRequestSchema.parse(validRequest)).toEqual(validRequest)
})

test("run schema rejects unsafe experiment bounds", () => {
  expect(runRequestSchema.safeParse({ ...validRequest, runs: 101 }).success).toBe(false)
  expect(runRequestSchema.safeParse({
    ...validRequest,
    fault: { ...validRequest.fault, delayMs: 30_001 },
  }).success).toBe(false)
})

test("run schema accepts bounded HTTP failure injection", () => {
  const request = {
    ...validRequest,
    fault: {
      kind: "request-failure" as const,
      pattern: "**/api/checkout",
      statusCode: 503,
    },
  }

  expect(runRequestSchema.parse(request)).toEqual(request)
  expect(runRequestSchema.safeParse({
    ...request,
    fault: { ...request.fault, statusCode: 200 },
  }).success).toBe(false)
})
