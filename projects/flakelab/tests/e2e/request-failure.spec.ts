import { expect, test } from "@playwright/test"

import { installRequestFailure } from "../../src/faults/request-failure.js"
import type { CheckoutServer } from "../support/checkout-server.js"
import { startCheckoutServer } from "../support/checkout-server.js"

let checkout: CheckoutServer

test.beforeAll(async () => {
  checkout = await startCheckoutServer()
})

test.afterAll(async () => {
  await checkout.close()
})

test("HTTP failure injection is observable and fully removed", async ({ page }) => {
  await page.goto(checkout.url)
  const removeFault = await installRequestFailure(page, {
    kind: "request-failure",
    pattern: "**/api/checkout",
    statusCode: 503,
  })

  try {
    const injectedStatus = await page.evaluate(async () => {
      const response = await fetch("/api/checkout", { method: "POST" })
      return response.status
    })
    expect(injectedStatus).toBe(503)
  } finally {
    await removeFault()
  }

  const restoredStatus = await page.evaluate(async () => {
    const response = await fetch("/api/checkout", { method: "POST" })
    return response.status
  })
  expect(restoredStatus).toBe(200)
})
