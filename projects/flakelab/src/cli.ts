#!/usr/bin/env node

import { parseArgs } from "node:util"

import { bisect } from "./commands/bisect.js"
import { diagnose } from "./commands/diagnose.js"
import { discover } from "./commands/discover.js"
import { investigate } from "./commands/investigate.js"
import { repair } from "./commands/repair.js"
import { replay } from "./commands/replay.js"
import { generateReport } from "./commands/report.js"

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
      model: { type: "string", default: "qwen/qwen3.8-27b" },
      open: { type: "boolean", default: false },
      output: { type: "string", default: "flakelab.repro.yaml" },
      patch: { type: "string", default: "candidate.diff" },
      pattern: { type: "string", default: "**/api/checkout" },
      publish: { type: "boolean", default: false },
      proof: { type: "string", default: "flakelab.proof.json" },
      report: { type: "string", default: "flakelab.investigation.json" },
      reproducer: { type: "string", default: "flakelab.repro.yaml" },
      runs: { type: "string", default: "4" },
      seed: { type: "string", default: "1" },
      trials: { type: "string", default: "4" },
    },
  })
  const [command, target] = positionals
  if (command === "bisect") {
    await bisect(values)
    return
  }
  if (!target) {
    throw new Error(
      "Usage: flakelab <diagnose|discover|investigate|repair|replay|report> <target> | flakelab bisect --good <revision> [--bad HEAD]",
    )
  }
  if (command === "diagnose") {
    await diagnose(target, values)
    return
  }
  if (command === "discover") {
    await discover(target, values)
    return
  }
  if (command === "investigate") {
    await investigate(target, values)
    return
  }
  if (command === "repair") {
    await repair(target, values)
    return
  }
  if (command === "report") {
    await generateReport(target, values)
    return
  }
  if (command === "replay") {
    await replay(target, values)
    return
  }
  throw new Error(
    "Usage: flakelab <diagnose|discover|investigate|repair|replay|report> <target> | flakelab bisect --good <revision> [--bad HEAD]",
  )
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : "FlakeLab failed")
  process.exitCode = 1
}
