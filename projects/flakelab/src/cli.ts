import { parseArgs } from "node:util"

import { helpText, VERSION } from "./cli-help.js"
import { bisect } from "./commands/bisect.js"
import { diagnose } from "./commands/diagnose.js"
import { discover } from "./commands/discover.js"
import { investigate } from "./commands/investigate.js"
import type { CliValues } from "./commands/options.js"
import { prove } from "./commands/prove.js"
import { repair } from "./commands/repair.js"
import { replay } from "./commands/replay.js"
import { generateReport } from "./commands/report.js"
import { scan } from "./commands/scan.js"

const ADVANCED_COMMANDS = new Set([
  "bisect",
  "diagnose",
  "discover",
  "investigate",
  "repair",
  "replay",
  "report",
  "scan",
])

async function runAdvanced(command: string, target: string | undefined, values: CliValues): Promise<void> {
  if (command === "bisect") {
    await bisect(values)
    return
  }
  const selectedTarget = target ?? (command === "scan" ? "." : undefined)
  if (!selectedTarget) {
    throw new Error(`${command} requires a target. Run flakelab --help for examples.`)
  }
  const commands: Record<string, (value: string, options: CliValues) => Promise<void>> = {
    diagnose,
    discover,
    investigate,
    repair,
    replay,
    report: generateReport,
    scan: async (value, options) => {
      await scan(value, options)
    },
  }
  await commands[command](selectedTarget, values)
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      artifacts: { type: "string", default: ".flakelab/runs" },
      bad: { type: "string", default: "HEAD" },
      "bisect-parallelism": { type: "string", default: "2" },
      "bisect-report": { type: "string", default: "flakelab.bisect.json" },
      concurrency: { type: "string", default: "4" },
      "delay-ms": { type: "string", default: "250" },
      "max-cost": { type: "string", default: "0.25" },
      "max-delay": { type: "string", default: "250" },
      "max-experiments": { type: "string", default: "3" },
      "max-seconds": { type: "string", default: "90" },
      "max-steps": { type: "string", default: "3" },
      "max-trials": { type: "string", default: "12" },
      "min-rate": { type: "string", default: "0.7" },
      html: { type: "string", default: "flakelab.report.html" },
      good: { type: "string", default: "" },
      help: { type: "boolean", short: "h", default: false },
      model: { type: "string", default: "qwen/qwen3.8-27b" },
      open: { type: "boolean", default: false },
      output: { type: "string", default: "flakelab.repro.yaml" },
      patch: { type: "string", default: "candidate.diff" },
      pattern: { type: "string", default: "**/api/checkout" },
      publish: { type: "boolean", default: false },
      proof: { type: "string", default: "flakelab.proof.json" },
      prove: { type: "boolean", default: false },
      report: { type: "string", default: "flakelab.investigation.json" },
      reproducer: { type: "string", default: "flakelab.repro.yaml" },
      runs: { type: "string", default: "4" },
      seed: { type: "string", default: "1" },
      trials: { type: "string", default: "4" },
      verbose: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  })
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(helpText())
    return
  }
  const [first, second] = positionals
  if (ADVANCED_COMMANDS.has(first)) {
    await runAdvanced(first, second, values)
    return
  }
  if (second) {
    throw new Error("Default scan accepts one path. Run flakelab --help for command usage.")
  }
  if (values.prove) {
    await prove(first, values)
    return
  }
  await scan(first, values)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : "FlakeLab failed")
  process.exitCode = 1
}
