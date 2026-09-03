import type { Page, Route } from "@playwright/test"

import type { RequestFailureFault } from "../domain/schema.js"
import { requestFailureFaultSchema } from "../domain/schema.js"

export type RemoveRequestFailure = () => Promise<void>

export async function installRequestFailure(
  page: Page,
  fault: RequestFailureFault,
): Promise<RemoveRequestFailure> {
  const validatedFault = requestFailureFaultSchema.parse(fault)
  const handler = async (route: Route): Promise<void> => {
    await route.fulfill({
      status: validatedFault.statusCode,
      contentType: "application/json",
      body: '{"error":"flakelab-injected-failure"}',
    })
  }
  await page.route(validatedFault.pattern, handler)
  return async () => page.unroute(validatedFault.pattern, handler)
}

export function readRequestFailureFromEnvironment(): RequestFailureFault | undefined {
  if (process.env.FLAKELAB_FAULT_KIND !== "request-failure") {
    return undefined
  }
  return requestFailureFaultSchema.parse({
    kind: "request-failure",
    pattern: process.env.FLAKELAB_NETWORK_PATTERN,
    statusCode: Number(process.env.FLAKELAB_REQUEST_FAILURE_STATUS ?? "503"),
  })
}
