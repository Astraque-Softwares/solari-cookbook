import type { Page, Route } from "@playwright/test"

import { setTimeout as delay } from "node:timers/promises"
import type { NetworkDelayFault } from "../domain/schema.js"
import { networkDelayFaultSchema } from "../domain/schema.js"

export type RemoveNetworkDelay = () => Promise<void>

async function continueRoute(route: Route): Promise<void> {
  try {
    await route.continue()
  } catch (error) {
    const releasedDuringCleanup =
      error instanceof Error && error.message.includes("Route is already handled")
    if (!releasedDuringCleanup) {
      throw error
    }
  }
}

export async function installNetworkDelay(
  page: Page,
  fault: NetworkDelayFault,
): Promise<RemoveNetworkDelay> {
  const validatedFault = networkDelayFaultSchema.parse(fault)
  const handler = async (route: Route): Promise<void> => {
    await delay(validatedFault.delayMs)
    await continueRoute(route)
  }

  await page.route(validatedFault.pattern, handler)
  return async () => page.unroute(validatedFault.pattern, handler)
}

export function readNetworkDelayFromEnvironment(): NetworkDelayFault | undefined {
  if (process.env.FLAKELAB_FAULT_KIND === "request-failure") {
    return undefined
  }
  const delayMs = Number(process.env.FLAKELAB_NETWORK_DELAY_MS ?? "0")
  const pattern = process.env.FLAKELAB_NETWORK_PATTERN?.trim()
  if (!pattern || delayMs <= 0) {
    return undefined
  }
  return networkDelayFaultSchema.parse({ kind: "network-delay", pattern, delayMs })
}
