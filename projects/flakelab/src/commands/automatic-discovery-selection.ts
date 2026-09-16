import {
  AUTOMATIC_FAULT,
  selectAutomaticFault,
  type AutomaticFaultCandidateNotice,
  type AutomaticFaultSelection,
  type AutomaticScreeningCapabilities,
} from "../discovery/automatic.js"
import {
  localeSchema,
  startupEventSchema,
  timeZoneSchema,
} from "../domain/schema.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import type { DiscoverOptions } from "./options.js"
import { integerOption, positiveNumberOption } from "./options.js"

interface AutomaticSelectionOptions {
  capabilities: AutomaticScreeningCapabilities
  concurrency: number
  seed: number
  signal: AbortSignal
}

export async function automaticDiscoverySelection(
  execute: TrialExecutor,
  selector: string,
  values: DiscoverOptions,
  common: AutomaticSelectionOptions,
  onCandidate: (candidate: AutomaticFaultCandidateNotice) => void,
): Promise<AutomaticFaultSelection | undefined> {
  if (values.fault !== AUTOMATIC_FAULT) return undefined
  return selectAutomaticFault(execute, {
    animationRate: positiveNumberOption(values["animation-rate"], "animation-rate"),
    capabilities: common.capabilities,
    clockOffsetMs: integerOption(values["clock-offset-ms"], "clock-offset-ms"),
    concurrency: common.concurrency,
    eventLoopDurationMs: integerOption(values["max-stall-ms"], "max-stall-ms"),
    holdMs: integerOption(values["max-hold-ms"], "max-hold-ms"),
    locale: localeSchema.parse(values.locale),
    maximumDelayMs: integerOption(values["max-delay"], "max-delay"),
    maximumDuplicateBytes: integerOption(
      values["max-duplicate-bytes"],
      "max-duplicate-bytes",
    ),
    maximumRemoveBytes: integerOption(values["max-remove-bytes"], "max-remove-bytes"),
    pattern: values.pattern,
    seed: common.seed,
    selector,
    signal: common.signal,
    startupEvent: startupEventSchema.parse(values["startup-event"]),
    timezoneId: timeZoneSchema.parse(values.timezone),
    viewportHeight: integerOption(values["viewport-height"], "viewport-height"),
    viewportWidth: integerOption(values["viewport-width"], "viewport-width"),
  }, onCandidate)
}
