import { parseArgs } from "node:util"
import { join } from "node:path"

import type { DiagnoseOptions } from "../commands/options.js"

export interface DiagnoseInvocation {
  command: "diagnose"
  options: DiagnoseOptions
  target?: string
}

function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value
}

function configOption(value: string | undefined): Pick<DiagnoseOptions, "config"> {
  return value ? { config: value } : {}
}

function artifactDefault(
  value: string | undefined,
  artifacts: string,
  filename: string,
): string {
  return value ?? join(artifacts, filename)
}

export function parseDiagnoseArguments(args: string[]): DiagnoseInvocation {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      artifacts: { type: "string", default: ".flakelab/runs" },
      baseline: { type: "string" },
      concurrency: { type: "string", default: "2" },
      config: { type: "string" },
      discover: { type: "boolean", default: false },
      evidence: { type: "string" },
      html: { type: "string" },
      investigate: { type: "boolean", default: false },
      "max-cost": { type: "string", default: "0.25" },
      "max-delay": { type: "string", default: "250" },
      "max-experiments": { type: "string", default: "3" },
      "max-seconds": { type: "string", default: "600" },
      "max-steps": { type: "string", default: "4" },
      "max-trials": { type: "string", default: "12" },
      "min-rate": { type: "string", default: "0.7" },
      model: { type: "string", default: "qwen/qwen3.8-27b" },
      open: { type: "boolean", default: false },
      patch: { type: "string" },
      pattern: { type: "string", default: "auto" },
      proof: { type: "string" },
      "prompt-credentials": { type: "boolean", default: false },
      repair: { type: "boolean", default: false },
      report: { type: "string" },
      reproducer: { type: "string" },
      runs: { type: "string", default: "4" },
      seed: { type: "string", default: "1" },
      source: { type: "string", multiple: true, default: [] },
      trials: { type: "string", default: "4" },
    },
  })
  if (parsed.positionals.length > 1) {
    throw new Error("diagnose accepts at most one test target")
  }
  const target = parsed.positionals[0]
  if (!target && !parsed.values.report) {
    throw new Error("diagnose requires a test target or --report <blob-report>")
  }
  if (!target && (parsed.values.discover || parsed.values.investigate || parsed.values.repair)) {
    throw new Error("diagnose needs an explicit test target before running new experiments")
  }
  const artifacts = withDefault(parsed.values.artifacts, ".flakelab/runs")
  return {
    command: "diagnose",
    ...(target ? { target } : {}),
    options: {
      artifacts,
      baseline: parsed.values.baseline,
      concurrency: withDefault(parsed.values.concurrency, "2"),
      ...configOption(parsed.values.config),
      discover: withDefault(parsed.values.discover, false),
      evidence: artifactDefault(parsed.values.evidence, artifacts, "investigation.json"),
      html: artifactDefault(parsed.values.html, artifacts, "report.html"),
      investigate: withDefault(parsed.values.investigate, false),
      "max-cost": withDefault(parsed.values["max-cost"], "0.25"),
      "max-delay": withDefault(parsed.values["max-delay"], "250"),
      "max-experiments": withDefault(parsed.values["max-experiments"], "3"),
      "max-seconds": withDefault(parsed.values["max-seconds"], "600"),
      "max-steps": withDefault(parsed.values["max-steps"], "4"),
      "max-trials": withDefault(parsed.values["max-trials"], "12"),
      "min-rate": withDefault(parsed.values["min-rate"], "0.7"),
      model: withDefault(parsed.values.model, "qwen/qwen3.8-27b"),
      open: withDefault(parsed.values.open, false),
      patch: artifactDefault(parsed.values.patch, artifacts, "candidate.diff"),
      pattern: withDefault(parsed.values.pattern, "auto"),
      proof: artifactDefault(parsed.values.proof, artifacts, "proof.json"),
      "prompt-credentials": withDefault(parsed.values["prompt-credentials"], false),
      repair: withDefault(parsed.values.repair, false),
      report: parsed.values.report,
      reproducer: artifactDefault(parsed.values.reproducer, artifacts, "reproducer.yaml"),
      runs: withDefault(parsed.values.runs, "4"),
      seed: withDefault(parsed.values.seed, "1"),
      source: parsed.values.source ?? [],
      trials: withDefault(parsed.values.trials, "4"),
    },
  }
}
