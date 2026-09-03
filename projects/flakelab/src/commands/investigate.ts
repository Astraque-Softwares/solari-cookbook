import { config } from "dotenv"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { runInvestigation } from "../investigator/agent.js"
import {
  createGroqInvestigatorModel,
  QWEN_INPUT_USD_PER_MILLION,
  QWEN_OUTPUT_USD_PER_MILLION,
} from "../investigator/groq.js"
import { createPlaywrightExecutor } from "../runner/playwright-executor.js"
import { ProgressReporter } from "../ui/progress.js"
import type { CliValues } from "./options.js"
import {
  integerOption,
  positiveNumberOption,
  rateOption,
  withInterruption,
} from "./options.js"

export async function investigate(selector: string, values: CliValues): Promise<void> {
  config({ quiet: true })
  const apiKey = process.env.GROQ_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not configured; deterministic diagnose, discover, and replay remain available",
    )
  }
  const projectRoot = process.cwd()
  const progress = new ProgressReporter()
  progress.start("Planning and running causal experiments")
  const report = await withInterruption(async (signal) => runInvestigation({
    concurrency: integerOption(values.concurrency, "concurrency"),
    execute: createPlaywrightExecutor(projectRoot, selector, { signal }),
    inputUsdPerMillion: QWEN_INPUT_USD_PER_MILLION,
    maxCostUsd: positiveNumberOption(values["max-cost"], "max-cost"),
    maxExperiments: integerOption(values["max-experiments"], "max-experiments"),
    maximumDelayMs: integerOption(values["max-delay"], "max-delay"),
    maxSeconds: integerOption(values["max-seconds"], "max-seconds"),
    maxSteps: integerOption(values["max-steps"], "max-steps"),
    maxTrials: integerOption(values["max-trials"], "max-trials"),
    minimumFailureRate: rateOption(values["min-rate"]),
    model: createGroqInvestigatorModel(apiKey, values.model),
    modelId: values.model,
    outputTokenLimit: 512,
    outputUsdPerMillion: QWEN_OUTPUT_USD_PER_MILLION,
    pattern: values.pattern,
    projectRoot,
    seed: integerOption(values.seed, "seed"),
    signal,
    test: selector,
    trialsPerExperiment: integerOption(values.trials, "trials"),
  }))
  progress.done(`${report.experiments.length} experiments`)
  const reportPath = resolve(projectRoot, values.report)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" })
  console.log(JSON.stringify({ reportPath, ...report }, null, 2))
}
