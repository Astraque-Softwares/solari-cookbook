import type { Page } from "@playwright/test"

import type { Fault } from "../domain/schema.js"
import { installNetworkDelay } from "./network-delay.js"
import { installRequestFailure } from "./request-failure.js"

export type RemoveFault = () => Promise<void>

export async function installFault(page: Page, fault: Fault): Promise<RemoveFault> {
  if (fault.kind === "network-delay") {
    return installNetworkDelay(page, fault)
  }
  return installRequestFailure(page, fault)
}
