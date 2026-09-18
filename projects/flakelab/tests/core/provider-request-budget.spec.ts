import { expect, test } from "@playwright/test"

import { ProviderRequestBudget } from "../../src/providers/request-budget.js"

test("provider request budgets reserve exactly their configured call count", () => {
  const budget = new ProviderRequestBudget(2)

  expect(budget.remaining()).toBe(2)
  budget.reserve()
  expect(budget.remaining()).toBe(1)
  budget.reserve()
  expect(budget.remaining()).toBe(0)
  expect(() => budget.reserve()).toThrow("exhausted after 2 calls")
})
