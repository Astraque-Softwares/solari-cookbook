import type { InvestigationReport } from "../investigator/schema.js"
import type { AnalysisArtifact } from "../analysis/schema.js"
import type { Fault } from "../domain/schema.js"
import type { ProofOfFix } from "../repair/schema.js"
import { checkLabel } from "../repair/summary.js"
import type { Reproducer } from "../reproducer/schema.js"

interface JobSummaryInput {
  artifactUrl?: string
  investigation: InvestigationReport
  proof: ProofOfFix
  reproducer: Reproducer
}

function safeText(value: string): string {
  let withoutControls = ""
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    withoutControls += code < 32 || code === 127 ? " " : character
  }
  return withoutControls
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .trim()
}

function ratio(passed: number, trials: number): string {
  return `${passed}/${trials} passed`
}

function analysisTestLabel(finding: AnalysisArtifact["findings"][number]): string {
  const identity = finding.identity
  return `${identity.project} › ${identity.file}:${identity.line}:${identity.column} › ${identity.titlePath.join(" › ")}`
}

export function buildAnalysisJobSummary(
  analysis: AnalysisArtifact,
  artifactUrl?: string,
): string {
  const baseline = analysis.baseline
    ? `Compared with baseline \`${safeText(analysis.baseline)}\`.`
    : "No baseline was supplied; recurring failures are ranked without novelty scoring."
  const rows = analysis.findings.slice(0, 10).map((finding) =>
    `| ${finding.rank} | ${safeText(analysisTestLabel(finding))} | ${safeText(finding.status)} | ${finding.novelFailureModes} | ${safeText(finding.reasons.join("; "))} |`)
  const findings = rows.length > 0
    ? `| Rank | Test | Status | New signatures | Why investigate |\n| ---: | --- | --- | ---: | --- |\n${rows.join("\n")}`
    : "No failing or errored test results were found."
  const reportLink = artifactUrl?.startsWith("https://github.com/")
    ? `[Download the analyzed evidence](${artifactUrl})`
    : "Analyzed evidence is attached to this workflow run."
  return `# FlakeLab report analysis

**Source:** \`${safeText(analysis.source.path)}\`

**Executions:** ${analysis.totals.executions}; ${analysis.totals.failed} failed; ${analysis.totals.errors} errors

**Findings:** ${analysis.findings.length}; **new failure signatures:** ${analysis.findings.reduce((total, finding) => total + finding.novelFailureModes, 0)}

${baseline}

${findings}

${reportLink}
`
}

function byteLabel(count: number): string {
  return `${count} response ${count === 1 ? "byte" : "bytes"}`
}

type StateFault = Extract<Fault, { kind: "auth-cookie-expiry" | "storage-state-delay" }>
type TemporalFault = Extract<Fault, { kind: "clock-jump" | "locale" | "timezone" }>
type VisualFault = Extract<Fault, { kind: "animation-speed" | "reduced-motion" | "viewport" }>
type RunnerFault = Extract<Fault, { kind: "shared-state-interference" | "worker-pressure" }>
type EnvironmentFault = StateFault | TemporalFault | VisualFault

function isStateFault(fault: Fault): fault is StateFault {
  return fault.kind === "auth-cookie-expiry" || fault.kind === "storage-state-delay"
}

function isTemporalFault(fault: Fault): fault is TemporalFault {
  return fault.kind === "clock-jump" || fault.kind === "locale" || fault.kind === "timezone"
}

function isEnvironmentFault(fault: Fault): fault is EnvironmentFault {
  return isStateFault(fault)
    || isTemporalFault(fault)
    || fault.kind === "animation-speed"
    || fault.kind === "reduced-motion"
    || fault.kind === "viewport"
}

function stateFaultLabel(fault: StateFault): string {
  if (fault.kind === "auth-cookie-expiry") {
    return `cookie \`${safeText(fault.cookieName)}\` withheld matching \`${safeText(fault.pattern)}\``
  }
  return `${fault.storage} key \`${safeText(fault.key)}\` hidden ${fault.delayMs} ms matching \`${safeText(fault.pattern)}\``
}

function temporalFaultLabel(fault: TemporalFault): string {
  if (fault.kind === "clock-jump") {
    return `clock shifted ${fault.offsetMs} ms after ${fault.jumpAfterMs} ms matching \`${safeText(fault.pattern)}\``
  }
  if (fault.kind === "locale") {
    return `locale set to \`${safeText(fault.locale)}\` matching \`${safeText(fault.pattern)}\``
  }
  return `timezone set to \`${safeText(fault.timezoneId)}\` matching \`${safeText(fault.pattern)}\``
}

function visualFaultLabel(fault: VisualFault): string {
  if (fault.kind === "animation-speed") {
    return `animation speed set to ${fault.rate}x matching \`${safeText(fault.pattern)}\``
  }
  if (fault.kind === "reduced-motion") {
    return `reduced motion enabled matching \`${safeText(fault.pattern)}\``
  }
  return `${fault.width}x${fault.height} viewport matching \`${safeText(fault.pattern)}\``
}

function environmentFaultLabel(fault: EnvironmentFault): string {
  if (isStateFault(fault)) {
    return stateFaultLabel(fault)
  }
  return isTemporalFault(fault) ? temporalFaultLabel(fault) : visualFaultLabel(fault)
}

function isRunnerFault(fault: Fault): fault is RunnerFault {
  return fault.kind === "worker-pressure" || fault.kind === "shared-state-interference"
}

function runnerFaultLabel(fault: RunnerFault): string {
  return fault.kind === "worker-pressure"
    ? `${fault.workers} parallel workers targeting \`${safeText(fault.pattern)}\``
    : `${fault.copies} overlapping copies targeting \`${safeText(fault.pattern)}\``
}

function faultLabel(fault: Fault): string {
  if (isEnvironmentFault(fault)) {
    return environmentFaultLabel(fault)
  }
  if (isRunnerFault(fault)) {
    return runnerFaultLabel(fault)
  }
  if (fault.kind === "event-loop-stall") {
    return `event loop stalled ${fault.durationMs} ms after ${fault.startAfterMs} ms matching \`${safeText(fault.pattern)}\``
  }
  if (fault.kind === "network-delay") {
    return `${fault.delayMs} ms delay matching \`${safeText(fault.pattern)}\``
  }
  if (fault.kind === "request-failure") {
    return `HTTP ${fault.statusCode} matching \`${safeText(fault.pattern)}\``
  }
  if (fault.kind === "response-duplication") {
    return `${byteLabel(fault.duplicateBytes)} duplicated matching \`${safeText(fault.pattern)}\``
  }
  if (fault.kind === "response-reordering") {
    return `first response in each pair held ${fault.holdMs} ms matching \`${safeText(fault.pattern)}\``
  }
  if (fault.kind === "resource-loading-delay") {
    return `${fault.resourceType} loading delayed ${fault.delayMs} ms matching \`${safeText(fault.pattern)}\``
  }
  if (fault.kind === "startup-event-delay") {
    return `${fault.event} listeners delayed ${fault.delayMs} ms matching \`${safeText(fault.pattern)}\``
  }
  return `${byteLabel(fault.removeBytes)} removed matching \`${safeText(fault.pattern)}\``
}

export function buildJobSummary(input: JobSummaryInput): string {
  const trigger = input.reproducer.faults.map(faultLabel).join("; ")
  const result = input.proof.patchAccepted ? "Candidate fix proved" : "Candidate fix rejected"
  const reportLink = input.artifactUrl?.startsWith("https://github.com/")
    ? `[Download the portable evidence report](${input.artifactUrl})`
    : "Portable evidence report attached to this workflow run."
  return `# FlakeLab

## ${result}

**Test:** \`${safeText(input.reproducer.test)}\`  
**Confirmed hypothesis:** \`${safeText(input.investigation.conclusionHypothesisId)}\`  
**Stable trigger:** ${trigger}
**Replay:** \`flakelab replay flakelab.repro.yaml --concurrency 1\`

${safeText(input.investigation.conclusion)}

| Proof condition | Result | Failure rate |
| --- | ---: | ---: |
| Hostile before patch | ${ratio(input.proof.beforeHostile.passed, input.proof.beforeHostile.trials)} | ${(input.proof.beforeHostile.failureRate * 100).toFixed(0)}% |
| Hostile after patch | ${ratio(input.proof.afterHostile.passed, input.proof.afterHostile.trials)} | ${(input.proof.afterHostile.failureRate * 100).toFixed(0)}% |
| Normal after patch | ${ratio(input.proof.afterControl.passed, input.proof.afterControl.trials)} | ${(input.proof.afterControl.failureRate * 100).toFixed(0)}% |

Static checks: typecheck ${checkLabel(input.proof.staticChecks.typecheck)}; lint ${checkLabel(input.proof.staticChecks.lint)}.
Model: \`${safeText(input.investigation.model)}\`; estimated model cost: $${input.investigation.usage.estimatedCostUsd.toFixed(4)}.

Source context inspected: ${input.investigation.sourcePaths.map((path) => `\`${safeText(path)}\``).join(", ")}.
Candidate edit locations: ${input.proof.sourceLocations.map((location) => `\`${safeText(location.path)}:${location.line}\``).join(", ")}.

${reportLink}
`
}
