import { expect, test as base } from "@playwright/test"

import type { Fault } from "./domain/schema.js"
import { installFault } from "./faults/install.js"
import { readNetworkDelayFromEnvironment } from "./faults/network-delay.js"
import { readRequestFailureFromEnvironment } from "./faults/request-failure.js"

function readFaultFromEnvironment(): Fault | undefined {
  return readNetworkDelayFromEnvironment() ?? readRequestFailureFromEnvironment()
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const fault = readFaultFromEnvironment()
    const removeFault = fault ? await installFault(page, fault) : undefined
    try {
      await use(page)
    } finally {
      await removeFault?.()
    }
  },
})

export { expect }
