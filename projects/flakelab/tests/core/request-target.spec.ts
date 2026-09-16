import { expect, test } from "@playwright/test"

import { rankObservedRequestPatterns } from "../../src/runner/request-target.js"

test("request targeting prefers observed application data over development assets", () => {
  const candidates = rankObservedRequestPatterns([
    {
      count: 8,
      method: "GET",
      resourceType: "script",
      url: "http://localhost:4200/@vite/client",
    },
    {
      count: 2,
      method: "GET",
      resourceType: "script",
      url: "http://localhost:4200/kcab/kcab.worker.dev.js",
    },
    {
      count: 1,
      method: "POST",
      resourceType: "other",
      url: "http://localhost:3333/api/products/550e8400-e29b-41d4-a716-446655440000",
    },
  ])

  expect(candidates[0]).toMatchObject({
    pattern: "**/api/products/*",
    url: "http://localhost:3333/api/products/550e8400-e29b-41d4-a716-446655440000",
  })
  expect(candidates[1]?.pattern).toBe("**/kcab/kcab.worker.dev.js*")
})

test("request targeting falls back to an observed document without repository assumptions", () => {
  expect(rankObservedRequestPatterns([{
    count: 1,
    method: "GET",
    resourceType: "document",
    url: "http://localhost:8080/",
  }])[0]).toMatchObject({ pattern: "**/*" })
})
