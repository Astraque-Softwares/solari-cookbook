import { parseArgs } from "node:util"

import { parseAnalyzeArguments, type AnalyzeInvocation } from "./analysis/cli.js"
import {
  CLI_OPTION_DEFINITIONS as DEFINITIONS,
  requiredOption as required,
} from "./cli-option-definitions.js"
import { parseDiagnoseArguments, type DiagnoseInvocation } from "./diagnosis/cli.js"
import { parseProveArguments, type ProveInvocation } from "./proof/cli.js"
import type {
  BisectOptions,
  DiscoverOptions,
  InvestigateOptions,
  RepairOptions,
  ReplayOptions,
  ReportOptions,
  ScanOptions,
} from "./commands/options.js"

export type NamedCommand =
  | "analyze"
  | "bisect"
  | "diagnose"
  | "discover"
  | "doctor"
  | "investigate"
  | "prove"
  | "repair"
  | "replay"
  | "resume"
  | "report"
  | "scan"

export type CliInvocation =
  | AnalyzeInvocation
  | DiagnoseInvocation
  | ProveInvocation
  | { command: "help"; topic?: NamedCommand }
  | { command: "version" }
  | { command: "doctor" }
  | { command: "bisect"; options: BisectOptions }
  | { command: "discover"; options: DiscoverOptions; target: string }
  | { command: "investigate"; options: InvestigateOptions; target: string }
  | { command: "repair"; options: RepairOptions; target: string }
  | { command: "replay"; options: ReplayOptions; target: string }
  | { command: "resume"; target: string }
  | { command: "report"; options: ReportOptions; target: string }
  | { command: "scan"; options: ScanOptions; target: string }

const NAMED_COMMANDS: NamedCommand[] = [
  "analyze",
  "bisect",
  "diagnose",
  "discover",
  "doctor",
  "investigate",
  "prove",
  "repair",
  "replay",
  "resume",
  "report",
  "scan",
]

function oneTarget(positionals: string[], command: string): string {
  if (positionals.length !== 1) {
    throw new Error(`${command} requires exactly one target. Run flakelab --help for usage.`)
  }
  return positionals[0]
}

function noTarget(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new Error(`${command} does not accept a target`)
  }
}

function isNamedCommand(value: string | undefined): value is NamedCommand {
  return value !== undefined && NAMED_COMMANDS.some((command) => command === value)
}

function parseScan(args: string[]): CliInvocation {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      artifacts: DEFINITIONS.artifacts,
      concurrency: DEFINITIONS.concurrency,
      config: DEFINITIONS.config,
      json: DEFINITIONS.json,
      runs: DEFINITIONS.runs,
      verbose: DEFINITIONS.verbose,
    },
  })
  return {
    command: "scan",
    target: oneTarget(parsed.positionals, "scan"),
    options: {
      artifacts: required(parsed.values.artifacts, "artifacts"),
      concurrency: required(parsed.values.concurrency, "concurrency"),
      ...(parsed.values.config ? { config: parsed.values.config } : {}),
      json: required(parsed.values.json, "json"),
      runs: required(parsed.values.runs, "runs"),
      verbose: required(parsed.values.verbose, "verbose"),
    },
  }
}

function parseDiscover(args: string[]): CliInvocation {
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
      "jump-after-ms": DEFINITIONS.jumpAfterMs,
      locale: DEFINITIONS.locale,
      "max-delay": DEFINITIONS.maxDelay,
      "max-copies": DEFINITIONS.maxCopies,
      "max-duplicate-bytes": DEFINITIONS.maxDuplicateBytes,
      "max-hold-ms": DEFINITIONS.maxHoldMs,
      "max-remove-bytes": DEFINITIONS.maxRemoveBytes,
      "max-seconds": DEFINITIONS.discoveryMaxSeconds,
      "max-stall-ms": DEFINITIONS.maxStallMs,
      "max-workers": DEFINITIONS.maxWorkers,
      "min-rate": DEFINITIONS.minRate,
      output: DEFINITIONS.output,
      pattern: DEFINITIONS.pattern,
      "resource-type": DEFINITIONS.resourceType,
      seed: DEFINITIONS.seed,
      "startup-event": DEFINITIONS.startupEvent,
      "stall-after-ms": DEFINITIONS.stallAfterMs,
      storage: DEFINITIONS.storage,
      "storage-key": DEFINITIONS.storageKey,
      timezone: DEFINITIONS.timezone,
      trials: DEFINITIONS.trials,
      "viewport-height": DEFINITIONS.viewportHeight,
      "viewport-width": DEFINITIONS.viewportWidth,
    },
  })
  return {
    command: "discover",
    target: oneTarget(parsed.positionals, "discover"),
    options: {
      "animation-rate": required(parsed.values["animation-rate"], "animation-rate"),
      "clock-offset-ms": required(parsed.values["clock-offset-ms"], "clock-offset-ms"),
      concurrency: required(parsed.values.concurrency, "concurrency"),
      ...(parsed.values.config ? { config: parsed.values.config } : {}),
      ...(parsed.values["cookie-name"]
        ? { "cookie-name": parsed.values["cookie-name"] }
        : {}),
      fault: required(parsed.values.fault, "fault"),
      "jump-after-ms": required(parsed.values["jump-after-ms"], "jump-after-ms"),
      locale: required(parsed.values.locale, "locale"),
      "max-delay": required(parsed.values["max-delay"], "max-delay"),
      "max-copies": required(parsed.values["max-copies"], "max-copies"),
      "max-duplicate-bytes": required(
        parsed.values["max-duplicate-bytes"],
        "max-duplicate-bytes",
      ),
      "max-hold-ms": required(parsed.values["max-hold-ms"], "max-hold-ms"),
      "max-remove-bytes": required(
        parsed.values["max-remove-bytes"],
        "max-remove-bytes",
      ),
      "max-seconds": required(parsed.values["max-seconds"], "max-seconds"),
      "max-stall-ms": required(parsed.values["max-stall-ms"], "max-stall-ms"),
      "max-workers": required(parsed.values["max-workers"], "max-workers"),
      "min-rate": required(parsed.values["min-rate"], "min-rate"),
      output: required(parsed.values.output, "output"),
      pattern: required(parsed.values.pattern, "pattern"),
      "resource-type": required(parsed.values["resource-type"], "resource-type"),
      seed: required(parsed.values.seed, "seed"),
      "startup-event": required(parsed.values["startup-event"], "startup-event"),
      "stall-after-ms": required(parsed.values["stall-after-ms"], "stall-after-ms"),
      storage: required(parsed.values.storage, "storage"),
      ...(parsed.values["storage-key"]
        ? { "storage-key": parsed.values["storage-key"] }
        : {}),
      timezone: required(parsed.values.timezone, "timezone"),
      trials: required(parsed.values.trials, "trials"),
      "viewport-height": required(parsed.values["viewport-height"], "viewport-height"),
      "viewport-width": required(parsed.values["viewport-width"], "viewport-width"),
    },
  }
}

function parseReplay(args: string[]): CliInvocation {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { concurrency: DEFINITIONS.concurrency },
  })
  return {
    command: "replay",
    target: oneTarget(parsed.positionals, "replay"),
    options: { concurrency: required(parsed.values.concurrency, "concurrency") },
  }
}

function parseInvestigate(args: string[]): CliInvocation {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      concurrency: DEFINITIONS.concurrency,
      config: DEFINITIONS.config,
      "max-cost": DEFINITIONS.maxCost,
      "max-delay": DEFINITIONS.maxDelay,
      "max-experiments": DEFINITIONS.maxExperiments,
      "max-seconds": DEFINITIONS.maxSeconds,
      "max-steps": DEFINITIONS.maxSteps,
      "max-trials": DEFINITIONS.maxTrials,
      "min-rate": DEFINITIONS.minRate,
      model: DEFINITIONS.model,
      pattern: DEFINITIONS.pattern,
      "prompt-credentials": DEFINITIONS.promptCredentials,
      report: DEFINITIONS.report,
      seed: DEFINITIONS.seed,
      trials: DEFINITIONS.trials,
    },
  })
  return {
    command: "investigate",
    target: oneTarget(parsed.positionals, "investigate"),
    options: {
      concurrency: required(parsed.values.concurrency, "concurrency"),
      ...(parsed.values.config ? { config: parsed.values.config } : {}),
      "max-cost": required(parsed.values["max-cost"], "max-cost"),
      "max-delay": required(parsed.values["max-delay"], "max-delay"),
      "max-experiments": required(parsed.values["max-experiments"], "max-experiments"),
      "max-seconds": required(parsed.values["max-seconds"], "max-seconds"),
      "max-steps": required(parsed.values["max-steps"], "max-steps"),
      "max-trials": required(parsed.values["max-trials"], "max-trials"),
      "min-rate": required(parsed.values["min-rate"], "min-rate"),
      model: required(parsed.values.model, "model"),
      pattern: required(parsed.values.pattern, "pattern"),
      "prompt-credentials": required(
        parsed.values["prompt-credentials"],
        "prompt-credentials",
      ),
      report: required(parsed.values.report, "report"),
      seed: required(parsed.values.seed, "seed"),
      trials: required(parsed.values.trials, "trials"),
    },
  }
}

function parseRepair(args: string[]): CliInvocation {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      concurrency: { type: "string", default: "1" },
      "max-cost": DEFINITIONS.maxCost,
      "max-seconds": DEFINITIONS.maxSeconds,
      model: DEFINITIONS.model,
      patch: DEFINITIONS.patch,
      proof: DEFINITIONS.proof,
      "prompt-credentials": DEFINITIONS.promptCredentials,
      reproducer: DEFINITIONS.reproducer,
      source: DEFINITIONS.source,
    },
  })
  return {
    command: "repair",
    target: oneTarget(parsed.positionals, "repair"),
    options: {
      concurrency: required(parsed.values.concurrency, "concurrency"),
      "max-cost": required(parsed.values["max-cost"], "max-cost"),
      "max-seconds": required(parsed.values["max-seconds"], "max-seconds"),
      model: required(parsed.values.model, "model"),
      patch: required(parsed.values.patch, "patch"),
      proof: required(parsed.values.proof, "proof"),
      "prompt-credentials": required(
        parsed.values["prompt-credentials"],
        "prompt-credentials",
      ),
      reproducer: required(parsed.values.reproducer, "reproducer"),
      source: parsed.values.source ?? [],
    },
  }
}

function parseReport(args: string[]): CliInvocation {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      html: DEFINITIONS.html,
      open: DEFINITIONS.open,
      patch: DEFINITIONS.patch,
      proof: DEFINITIONS.proof,
      "prompt-credentials": DEFINITIONS.promptCredentials,
      publish: DEFINITIONS.publish,
      reproducer: DEFINITIONS.reproducer,
    },
  })
  return {
    command: "report",
    target: oneTarget(parsed.positionals, "report"),
    options: {
      html: required(parsed.values.html, "html"),
      open: required(parsed.values.open, "open"),
      patch: required(parsed.values.patch, "patch"),
      proof: required(parsed.values.proof, "proof"),
      "prompt-credentials": required(
        parsed.values["prompt-credentials"],
        "prompt-credentials",
      ),
      publish: required(parsed.values.publish, "publish"),
      reproducer: required(parsed.values.reproducer, "reproducer"),
    },
  }
}

function parseBisect(args: string[]): CliInvocation {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      bad: DEFINITIONS.bad,
      "bisect-parallelism": DEFINITIONS.bisectParallelism,
      "bisect-report": DEFINITIONS.bisectReport,
      concurrency: DEFINITIONS.concurrency,
      good: { type: "string" },
      "max-trials": DEFINITIONS.maxTrials,
      "min-rate": DEFINITIONS.minRate,
      "prompt-credentials": DEFINITIONS.promptCredentials,
      reproducer: DEFINITIONS.reproducer,
    },
  })
  noTarget(parsed.positionals, "bisect")
  if (!parsed.values.good) {
    throw new Error("bisect requires --good <revision>")
  }
  return {
    command: "bisect",
    options: {
      bad: required(parsed.values.bad, "bad"),
      "bisect-parallelism": required(
        parsed.values["bisect-parallelism"],
        "bisect-parallelism",
      ),
      "bisect-report": required(parsed.values["bisect-report"], "bisect-report"),
      concurrency: required(parsed.values.concurrency, "concurrency"),
      good: parsed.values.good,
      "max-trials": required(parsed.values["max-trials"], "max-trials"),
      "min-rate": required(parsed.values["min-rate"], "min-rate"),
      "prompt-credentials": required(
        parsed.values["prompt-credentials"],
        "prompt-credentials",
      ),
      reproducer: required(parsed.values.reproducer, "reproducer"),
    },
  }
}

function parseDoctor(args: string[]): CliInvocation {
  const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  noTarget(parsed.positionals, "doctor")
  return { command: "doctor" }
}

function parseResume(args: string[]): CliInvocation {
  const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  if (parsed.positionals.length !== 1) {
    throw new Error(
      "resume requires exactly one diagnosis checkpoint. Run flakelab --help for usage.",
    )
  }
  return { command: "resume", target: parsed.positionals[0] }
}

function explicitCommand(command: NamedCommand, args: string[]): CliInvocation {
  const parsers: Record<NamedCommand, (values: string[]) => CliInvocation> = {
    analyze: parseAnalyzeArguments,
    bisect: parseBisect,
    diagnose: parseDiagnoseArguments,
    discover: parseDiscover,
    doctor: parseDoctor,
    investigate: parseInvestigate,
    prove: parseProveArguments,
    repair: parseRepair,
    replay: parseReplay,
    resume: parseResume,
    report: parseReport,
    scan: parseScan,
  }
  return parsers[command](args)
}

function removeProveShortcut(args: string[]): string[] | undefined {
  const matches = args.filter((argument) => argument === "--prove").length
  if (matches === 0) {
    return undefined
  }
  if (matches > 1) {
    throw new Error("--prove may be specified only once")
  }
  return args.filter((argument) => argument !== "--prove")
}

/**
 * Help is resolved before any command parser runs, so `flakelab discover --help`
 * never has to satisfy that command's required arguments.
 */
function helpInvocation(args: string[]): CliInvocation | undefined {
  if (args.length === 0) {
    return { command: "help" }
  }
  if (!args.includes("--help") && !args.includes("-h")) {
    return undefined
  }
  const first = args[0]
  return isNamedCommand(first) ? { command: "help", topic: first } : { command: "help" }
}

export function parseCliArguments(args: string[]): CliInvocation {
  const help = helpInvocation(args)
  if (help) {
    return help
  }
  if (args.includes("--version") || args.includes("-v")) {
    return { command: "version" }
  }
  const first = args[0]
  if (isNamedCommand(first)) {
    return explicitCommand(first, args.slice(1))
  }
  const proofArgs = removeProveShortcut(args)
  return proofArgs ? parseProveArguments(proofArgs) : parseScan(args)
}
