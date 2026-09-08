import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { runInvestigation } from "../investigator/agent.js"
import type { RequiredExperimentEvidence } from "../investigator/agent.js"
import type { InvestigationReport } from "../investigator/schema.js"
import {
  createGroqInvestigatorModel,
  QWEN_INPUT_USD_PER_MILLION,
  QWEN_OUTPUT_USD_PER_MILLION,
} from "../investigator/groq.js"
import { createPlaywrightExecutor } from "../runner/playwright-executor.js"
import { requireCredential } from "../security/credentials.js"
import { formatProviderBoundary } from "../ui/boundary.js"
import { writeStderr } from "../ui/console.js"
import { formatCount, formatUsd } from "../ui/format.js"
import { ProgressReporter } from "../ui/progress.js"
import { stderrTheme } from "../ui/theme.js"
import type { InvestigateOptions } from "./options.js"
import {
  integerOption,
  positiveNumberOption,
  rateOption,
  withInterruption,
} from "./options.js"

export async function investigate(
  selector: string,
  values: InvestigateOptions,
  requiredEvidence?: RequiredExperimentEvidence,
): Promise<InvestigationReport> {
  writeStderr(formatProviderBoundary({
    credentials: ["GROQ_API_KEY"],
    detail: "Only compact experiment results and redacted failure metadata are sent."
      + " Source files, browser storage, and full logs are not transmitted.",
    rows: [
      { label: "Model", value: values.model },
      { label: "Cost ceiling", value: `$${values["max-cost"]}` },
      { label: "Time ceiling", value: `${values["max-seconds"]}s` },
      { label: "Experiments", value: `at most ${values["max-experiments"]}` },
    ],
    stage: "bounded Groq investigation",
  }, stderrTheme()))
  const apiKey = await requireCredential("groq", {
    forcePrompt: values["prompt-credentials"],
  })
  const projectRoot = process.cwd()
  const progress = new ProgressReporter()
  progress.start("investigation", "planning and running causal experiments")
  const report = await withInterruption(async (signal) => runInvestigation({
    concurrency: integerOption(values.concurrency, "concurrency"),
    execute: createPlaywrightExecutor(projectRoot, selector, { captureTrace: true, signal }),
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
    requiredEvidence,
    seed: integerOption(values.seed, "seed"),
    signal,
    test: selector,
    trialsPerExperiment: integerOption(values.trials, "trials"),
  }))
  progress.done(
    `${formatCount(report.experiments.length, "experiment")}`
    + ` · ${report.usage.inputTokens + report.usage.outputTokens} tokens`
    + ` · ${formatUsd(report.usage.estimatedCostUsd, 4)}`,
  )
  const reportPath = resolve(projectRoot, values.report)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" })
  console.log(JSON.stringify({ reportPath, ...report }, null, 2))
  return report
}
