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
import {
  discoverRepositoryProfile,
  repositoryEnvironment,
  writeRepositoryProfile,
} from "../project/profile.js"
import type { RepositoryProfile } from "../project/schema.js"
import {
  AUTOMATIC_REQUEST_PATTERN,
  resolveRequestPattern,
} from "../runner/request-target.js"
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

function evidenceRequestPattern(
  requiredEvidence: RequiredExperimentEvidence | undefined,
): string | undefined {
  if (!requiredEvidence || !("pattern" in requiredEvidence.condition)) return undefined
  return typeof requiredEvidence.condition.pattern === "string"
    ? requiredEvidence.condition.pattern
    : undefined
}

async function investigationRequestPattern(
  selector: string,
  values: InvestigateOptions,
  profile: RepositoryProfile,
  requiredEvidence: RequiredExperimentEvidence | undefined,
): Promise<string> {
  const requested = evidenceRequestPattern(requiredEvidence) ?? values.pattern
  if (requested !== AUTOMATIC_REQUEST_PATTERN) return requested
  const calibration = new ProgressReporter()
  calibration.start("request calibration", "observing the selected test without a fault")
  try {
    const resolved = await withInterruption(
      async (signal) => resolveRequestPattern({
        pattern: requested,
        repository: profile,
        seed: integerOption(values.seed, "seed"),
        selector,
        signal,
      }),
      { maxSeconds: integerOption(values["max-seconds"], "max-seconds") },
    )
    calibration.done(`${resolved.pattern} · ${resolved.candidates[0]?.reason ?? "observed request"}`)
    return resolved.pattern
  } catch (error) {
    calibration.fail("no safe request target selected")
    throw error
  }
}

export async function investigate(
  selector: string,
  values: InvestigateOptions,
  requiredEvidence?: RequiredExperimentEvidence,
  repository?: RepositoryProfile,
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
  const ownsProfile = repository === undefined
  const profile = repository ?? await discoverRepositoryProfile({
    artifactDirectory: ".flakelab/runs",
    config: values.config,
    invocationRoot: process.cwd(),
    target: selector,
  })
  if (ownsProfile) await writeRepositoryProfile(profile, ".flakelab/runs")
  const projectRoot = profile.artifactRoot
  selector = profile.playwright.target
  const requestPattern = await investigationRequestPattern(
    selector,
    values,
    profile,
    requiredEvidence,
  )
  const apiKey = await requireCredential("groq", {
    forcePrompt: values["prompt-credentials"],
  })
  const progress = new ProgressReporter()
  progress.start("investigation", "planning and running causal experiments")
  const report = await withInterruption(async (signal) => runInvestigation({
    concurrency: integerOption(values.concurrency, "concurrency"),
    execute: createPlaywrightExecutor(profile.executionRoot, selector, {
      artifactRoot: profile.artifactRoot,
      captureTrace: true,
      configPath: profile.playwright.configPath,
      environment: repositoryEnvironment(profile),
      playwrightCliPath: profile.playwright.cliPath,
      signal,
    }),
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
    pattern: requestPattern,
    projectRoot: profile.executionRoot,
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
