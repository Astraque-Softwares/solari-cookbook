import { parseArgs } from "node:util"

import {
  CLI_OPTION_DEFINITIONS as DEFINITIONS,
  requiredOption as required,
} from "../cli-option-definitions.js"
import type { ProveOptions } from "../commands/options.js"

export interface ProveInvocation {
  command: "prove"
  options: ProveOptions
  target: string
}

function oneTarget(positionals: string[]): string {
  if (positionals.length !== 1) {
    throw new Error("prove requires exactly one target. Run flakelab --help for usage.")
  }
  return positionals[0]
}

export function parseProveArguments(args: string[]): ProveInvocation {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "animation-rate": DEFINITIONS.animationRate,
      "clock-offset-ms": DEFINITIONS.clockOffsetMs,
      concurrency: DEFINITIONS.concurrency,
      config: DEFINITIONS.config,
      "cookie-name": DEFINITIONS.cookieName,
      fault: DEFINITIONS.fault,
      html: DEFINITIONS.html,
      "jump-after-ms": DEFINITIONS.jumpAfterMs,
      locale: DEFINITIONS.locale,
      "max-copies": DEFINITIONS.maxCopies,
      "max-cost": DEFINITIONS.maxCost,
      "max-delay": DEFINITIONS.maxDelay,
      "max-duplicate-bytes": DEFINITIONS.maxDuplicateBytes,
      "max-experiments": DEFINITIONS.maxExperiments,
      "max-hold-ms": DEFINITIONS.maxHoldMs,
      "max-remove-bytes": DEFINITIONS.maxRemoveBytes,
      "max-seconds": DEFINITIONS.discoveryMaxSeconds,
      "max-stall-ms": DEFINITIONS.maxStallMs,
      "max-steps": DEFINITIONS.maxSteps,
      "max-trials": DEFINITIONS.maxTrials,
      "max-workers": DEFINITIONS.maxWorkers,
      "min-rate": DEFINITIONS.minRate,
      model: DEFINITIONS.model,
      open: DEFINITIONS.open,
      patch: DEFINITIONS.patch,
      pattern: DEFINITIONS.pattern,
      proof: DEFINITIONS.proof,
      "prompt-credentials": DEFINITIONS.promptCredentials,
      publish: DEFINITIONS.publish,
      report: DEFINITIONS.report,
      reproducer: DEFINITIONS.reproducer,
      "resource-type": DEFINITIONS.resourceType,
      seed: DEFINITIONS.seed,
      source: DEFINITIONS.source,
      "stall-after-ms": DEFINITIONS.stallAfterMs,
      "startup-event": DEFINITIONS.startupEvent,
      storage: DEFINITIONS.storage,
      "storage-key": DEFINITIONS.storageKey,
      timezone: DEFINITIONS.timezone,
      trials: DEFINITIONS.trials,
      "viewport-height": DEFINITIONS.viewportHeight,
      "viewport-width": DEFINITIONS.viewportWidth,
    },
  })
  return {
    command: "prove",
    target: oneTarget(parsed.positionals),
    options: {
      "animation-rate": required(parsed.values["animation-rate"], "animation-rate"),
      "clock-offset-ms": required(parsed.values["clock-offset-ms"], "clock-offset-ms"),
      concurrency: required(parsed.values.concurrency, "concurrency"),
      ...(parsed.values.config ? { config: parsed.values.config } : {}),
      ...(parsed.values["cookie-name"] ? { "cookie-name": parsed.values["cookie-name"] } : {}),
      fault: required(parsed.values.fault, "fault"),
      html: required(parsed.values.html, "html"),
      "jump-after-ms": required(parsed.values["jump-after-ms"], "jump-after-ms"),
      locale: required(parsed.values.locale, "locale"),
      "max-copies": required(parsed.values["max-copies"], "max-copies"),
      "max-cost": required(parsed.values["max-cost"], "max-cost"),
      "max-delay": required(parsed.values["max-delay"], "max-delay"),
      "max-duplicate-bytes": required(
        parsed.values["max-duplicate-bytes"],
        "max-duplicate-bytes",
      ),
      "max-experiments": required(parsed.values["max-experiments"], "max-experiments"),
      "max-hold-ms": required(parsed.values["max-hold-ms"], "max-hold-ms"),
      "max-remove-bytes": required(parsed.values["max-remove-bytes"], "max-remove-bytes"),
      "max-seconds": required(parsed.values["max-seconds"], "max-seconds"),
      "max-stall-ms": required(parsed.values["max-stall-ms"], "max-stall-ms"),
      "max-steps": required(parsed.values["max-steps"], "max-steps"),
      "max-trials": required(parsed.values["max-trials"], "max-trials"),
      "max-workers": required(parsed.values["max-workers"], "max-workers"),
      "min-rate": required(parsed.values["min-rate"], "min-rate"),
      model: required(parsed.values.model, "model"),
      open: required(parsed.values.open, "open"),
      output: required(parsed.values.reproducer, "reproducer"),
      patch: required(parsed.values.patch, "patch"),
      pattern: required(parsed.values.pattern, "pattern"),
      proof: required(parsed.values.proof, "proof"),
      "prompt-credentials": required(
        parsed.values["prompt-credentials"],
        "prompt-credentials",
      ),
      publish: required(parsed.values.publish, "publish"),
      report: required(parsed.values.report, "report"),
      reproducer: required(parsed.values.reproducer, "reproducer"),
      "resource-type": required(parsed.values["resource-type"], "resource-type"),
      seed: required(parsed.values.seed, "seed"),
      source: parsed.values.source ?? [],
      "stall-after-ms": required(parsed.values["stall-after-ms"], "stall-after-ms"),
      "startup-event": required(parsed.values["startup-event"], "startup-event"),
      storage: required(parsed.values.storage, "storage"),
      ...(parsed.values["storage-key"] ? { "storage-key": parsed.values["storage-key"] } : {}),
      timezone: required(parsed.values.timezone, "timezone"),
      trials: required(parsed.values.trials, "trials"),
      "viewport-height": required(parsed.values["viewport-height"], "viewport-height"),
      "viewport-width": required(parsed.values["viewport-width"], "viewport-width"),
    },
  }
}
