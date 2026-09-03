import { expect, test } from "../../src/playwright.js"
import type { CheckoutServer } from "../support/checkout-server.js"
import { startCheckoutServer } from "../support/checkout-server.js"

let checkout: CheckoutServer

test.beforeAll(async () => {
  checkout = await startCheckoutServer()
})

test.afterAll(async () => {
  await checkout.close()
})

test("checkout completes before the product deadline", async ({ page }) => {
  // The product deadline must remain safe under realistic response latency.
  await page.goto(checkout.url)
  await page.getByRole("button", { name: "Place order" }).click()
  await expect(page.getByRole("status")).toHaveText("Checkout complete", { timeout: 750 })
})
