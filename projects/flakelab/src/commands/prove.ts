import { formatProviderBoundary } from "../ui/boundary.js"
import { experimentConditionSchema } from "../investigator/schema.js"
import { preflightProofCredentials } from "../proof/preflight.js"
import { writeStderr } from "../ui/console.js"
import { TerminalDocument } from "../ui/document.js"
import { formatCount } from "../ui/format.js"
import { stderrTheme } from "../ui/theme.js"
import { discover } from "./discover.js"
import { investigate } from "./investigate.js"
import type { ProveOptions } from "./options.js"
import { repair } from "./repair.js"
import { replay } from "./replay.js"
import { generateReport } from "./report.js"
import { discoverRepositoryProfile, writeRepositoryProfile } from "../project/profile.js"

const PIPELINE = "discover, replay, investigate, repair, report"

function ensureSuccessfulStage(stage: string): void {
  if (process.exitCode && process.exitCode !== 0) {
    throw new Error(`${stage} did not produce acceptable evidence`)
  }
}

function announceBoundary(values: ProveOptions): void {
  writeStderr(formatProviderBoundary({
    credentials: ["GROQ_API_KEY", "SOLARI_API_KEY"],
    detail: `The full proof pipeline runs ${PIPELINE}. Local discovery and replay use no`
      + " provider. Investigation and repair send compact, redacted evidence to Groq, and"
      + " proof runs in one disposable Solari microVM.",
    rows: [
      { label: "Fault family", value: values.fault },
      { label: "Model", value: values.model },
      { label: "Cost ceiling", value: `$${values["max-cost"]}` },
      { label: "Discovery bound", value: `${values["max-seconds"]}s` },
      { label: "Approved source", value: formatCount(values.source.length, "file") },
    ],
    stage: "full proof pipeline",
  }, stderrTheme()))
}

function announceCompletion(values: ProveOptions): void {
  const document = new TerminalDocument(stderrTheme())
  document.entry("success", "proof pipeline complete", `Ran ${PIPELINE}.`)
  document.rows([
    { label: "Reproducer", value: values.output },
    { label: "Investigation", value: values.report },
    { label: "Patch", value: values.patch },
    { label: "Proof", value: values.proof },
    { label: "Report", value: values.html },
  ])
  writeStderr(document.render())
}

export async function prove(target: string, values: ProveOptions): Promise<void> {
  const repository = await discoverRepositoryProfile({
    artifactDirectory: ".flakelab/runs",
    config: values.config,
    invocationRoot: process.cwd(),
    target,
  })
  await writeRepositoryProfile(repository, ".flakelab/runs")
  announceBoundary(values)
  await preflightProofCredentials(values["prompt-credentials"])
  const discovery = await discover(target, values, repository)
  if ("screenings" in discovery) {
    throw new Error("No fault signal was observed in the applicable bounded screen")
  }
  await replay(values.output, values, repository)
  ensureSuccessfulStage("Reproducer replay")
  await investigate(target, values, {
    condition: experimentConditionSchema.parse(discovery.trigger),
    result: discovery.triggerResult,
  }, repository)
  await repair(values.report, { ...values, concurrency: "1" }, repository)
  ensureSuccessfulStage("Candidate repair")
  await generateReport(values.report, values, repository)
  announceCompletion(values)
}
