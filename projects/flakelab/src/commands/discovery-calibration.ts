import type { RepositoryProfile } from "../project/schema.js"
import {
  AUTOMATIC_REQUEST_PATTERN,
  resolveRequestPattern,
} from "../runner/request-target.js"
import { ProgressReporter } from "../ui/progress.js"
import type { DiscoverOptions } from "./options.js"
import { integerOption, withInterruption } from "./options.js"

function usesRunnerTarget(fault: string): boolean {
  return fault === "shared-state-interference" || fault === "worker-pressure"
}

function usesDocumentTarget(fault: string): boolean {
  return [
    "animation-speed",
    "clock-jump",
    "event-loop-stall",
    "locale",
    "reduced-motion",
    "resource-loading-delay",
    "startup-event-delay",
    "timezone",
    "viewport",
  ].includes(fault)
}

export async function calibrateDiscovery(
  selector: string,
  values: DiscoverOptions,
  repository: RepositoryProfile,
  maxSeconds: number,
): Promise<{ elapsedSeconds: number; values: DiscoverOptions }> {
  if (values.pattern !== AUTOMATIC_REQUEST_PATTERN) return { elapsedSeconds: 0, values }
  if (usesRunnerTarget(values.fault)) {
    return { elapsedSeconds: 0, values: { ...values, pattern: selector } }
  }
  if (usesDocumentTarget(values.fault)) {
    return { elapsedSeconds: 0, values: { ...values, pattern: "**" } }
  }
  const reporter = new ProgressReporter()
  reporter.start("request calibration", "observing the selected test without a fault")
  const startedAt = Date.now()
  try {
    const resolved = await withInterruption(
      async (signal) => resolveRequestPattern({
        pattern: values.pattern,
        repository,
        seed: integerOption(values.seed, "seed"),
        selector,
        signal,
      }),
      { maxSeconds, timeoutMessage: "Request calibration exceeded the discovery time limit" },
    )
    reporter.done(`${resolved.pattern} · ${resolved.candidates[0]?.reason ?? "observed request"}`)
    return {
      elapsedSeconds: (Date.now() - startedAt) / 1_000,
      values: { ...values, pattern: resolved.pattern },
    }
  } catch (error) {
    reporter.fail("no safe request target selected")
    throw error
  }
}
