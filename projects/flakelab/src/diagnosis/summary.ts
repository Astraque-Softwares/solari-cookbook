import type { DocumentRow } from "../ui/document.js"
import { TerminalDocument } from "../ui/document.js"
import { formatDuration, formatUsd } from "../ui/format.js"
import type { StatusTone } from "../ui/status.js"
import type { TerminalTheme } from "../ui/theme.js"
import { PLAIN_THEME } from "../ui/theme.js"
import type { DiagnosisArtifact, DiagnosisStage } from "./schema.js"

const STATUS_TONES: Record<DiagnosisArtifact["status"], StatusTone> = {
  complete: "success",
  failed: "failure",
  interrupted: "warning",
  running: "running",
}

const STAGE_TONES: Record<DiagnosisStage, StatusTone> = {
  "candidate-invalid": "failure",
  investigated: "success",
  "no-signal-observed": "success",
  observed: "success",
  "repair-proven": "success",
  "repair-rejected": "failure",
  "reproducer-created": "success",
}

function verdictTone(artifact: DiagnosisArtifact): StatusTone {
  if (artifact.status !== "complete") {
    return STATUS_TONES[artifact.status]
  }
  return STAGE_TONES[artifact.stage]
}

function solariEstimate(value: number | null): string {
  return value === null ? "not available" : formatUsd(value)
}

function plannedRows(artifact: DiagnosisArtifact): DocumentRow[] {
  const recommendation = artifact.recommendation
  const rows: DocumentRow[] = [
    { label: "Runs", value: `${recommendation.plannedTrials}` },
    { label: "Time", value: recommendation.expectedDuration },
    { label: "Solari cost", value: solariEstimate(recommendation.solariCostEstimateUsd) },
  ]
  if (recommendation.aiCostLimitUsd !== null) {
    rows.push({ label: "AI cost cap", value: formatUsd(recommendation.aiCostLimitUsd) })
  }
  rows.push({
    label: "Credentials",
    value: recommendation.credentials.length > 0
      ? recommendation.credentials.join(" · ")
      : "none",
  })
  return rows
}

function consumedRows(artifact: DiagnosisArtifact): DocumentRow[] {
  const actual = artifact.usage.actual
  return [
    { label: "Runs", value: `${actual.executions}` },
    { label: "Wall time", value: formatDuration(actual.elapsedMilliseconds) },
    {
      label: "AI tokens",
      value: `${actual.aiInputTokens} input · ${actual.aiOutputTokens} output`,
    },
    { label: "AI cost est.", value: formatUsd(actual.aiEstimatedCostUsd, 4) },
    {
      label: "Solari",
      value: `${actual.solariSandboxesCreated} created`
        + ` · ${actual.solariSandboxesKilled} released`,
    },
    {
      label: "Solari cost",
      value: actual.solariCostUsd === null
        ? "not available from provider"
        : formatUsd(actual.solariCostUsd),
    },
  ]
}

function appendEvidence(document: TerminalDocument, artifact: DiagnosisArtifact, path: string): void {
  const rows: DocumentRow[] = [{ label: "Diagnosis", value: path }]
  const artifacts: [string, string | null][] = [
    ["Analysis", artifact.artifacts.analysis],
    ["Scan", artifact.artifacts.scan],
    ["Discovery", artifact.artifacts.discovery],
    ["Reproducer", artifact.artifacts.reproducer],
    ["Investigation", artifact.artifacts.evidence],
    ["Patch", artifact.artifacts.patch],
    ["Proof", artifact.artifacts.proof],
    ["Report", artifact.artifacts.html],
  ]
  for (const [label, value] of artifacts) {
    if (value) {
      rows.push({ label, value })
    }
  }
  document.section("Evidence").rows(rows)
}

export function formatDiagnosisSummary(
  artifact: DiagnosisArtifact,
  path: string,
  theme: TerminalTheme = PLAIN_THEME,
): string {
  const recommendation = artifact.recommendation
  const document = new TerminalDocument(theme)
  document.heading("adaptive diagnosis")
  document.verdict(
    verdictTone(artifact),
    `${artifact.stage} · ${artifact.status}`,
    recommendation.rationale,
  )
  if (artifact.lastError) {
    document.detail(artifact.lastError, "failure")
  }
  document.blank().rows([
    { label: "Observed", value: artifact.observation.status },
    {
      label: "Measured",
      value: `${artifact.observation.tests} test(s)`
        + ` · ${artifact.observation.failures} failure(s)`
        + ` · ${artifact.observation.executions} execution(s)`,
    },
  ])
  document.section("Planned").rows(plannedRows(artifact))
  document.note(recommendation.solariCostNote)
  document.section("Consumed").rows(consumedRows(artifact))
  document.section("Resources").rows([
    { label: "Cache", value: `${artifact.cache.status} · ${artifact.cache.reason}` },
    { label: "Cleanup", value: artifact.cleanup.status },
  ])
  appendEvidence(document, artifact, path)
  if (recommendation.command) {
    document.section("Next").command(recommendation.command)
  }
  return document.render()
}
