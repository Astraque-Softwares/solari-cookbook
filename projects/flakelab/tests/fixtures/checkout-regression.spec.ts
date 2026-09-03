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

test("checkout preserves its normal ready and completion states", async ({ page }) => {
  await page.goto(checkout.url)
  await expect(page.getByRole("status")).toHaveText("Ready")
  await page.getByRole("button", { name: "Place order" }).click()
  await expect(page.getByRole("status")).toHaveText("Checkout complete")
})
