import { stat } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { readInvestigationReport } from "../investigator/file.js"
import { readProofOfFix } from "../repair/file.js"
import { writePortableReport } from "../report/bundle.js"
import { buildEvidenceReport } from "../report/model.js"
import { assertRepositoryUnchanged } from "../project/profile.js"
import type { RepositoryProfile } from "../project/schema.js"
import { confirmLocalReportOpen, openLocalReport } from "../report/open.js"
import { readReproducer } from "../reproducer/file.js"
import { requireCredential } from "../security/credentials.js"
import { writeStderr } from "../ui/console.js"
import { TerminalDocument } from "../ui/document.js"
import { formatCount } from "../ui/format.js"
import { ProgressReporter } from "../ui/progress.js"
import { stderrTheme } from "../ui/theme.js"
import type { ReportOptions } from "./options.js"

function portablePath(projectRoot: string, path: string): string {
  const portable = relative(projectRoot, resolve(projectRoot, path)).replaceAll("\\", "/")
  if (portable.startsWith("../") || portable === "..") {
    throw new Error("Report artifacts must stay inside the project")
  }
  return portable
}

interface ReportVerdict {
  classification: string
  html: string
  kilobytes: number
  publishedUrl?: string
  status: string
}

async function verifiedRepository(repository?: RepositoryProfile): Promise<{
  repository?: RepositoryProfile
}> {
  if (!repository) return {}
  await assertRepositoryUnchanged(repository)
  return { repository }
}

function reportSummary(verdict: ReportVerdict): string {
  const document = new TerminalDocument(stderrTheme())
  document.entry(
    verdict.status === "FIX_PROVEN" ? "success" : "warning",
    verdict.status,
    `Ownership classified as ${verdict.classification}.`,
  )
  const rows = [
    { label: "Report", value: `${verdict.html} · ${verdict.kilobytes} KiB` },
  ]
  if (verdict.publishedUrl) {
    rows.push({ label: "Published", value: verdict.publishedUrl })
  }
  return document.rows(rows).render()
}

export async function generateReport(
  investigationPath: string,
  values: ReportOptions,
  repository?: RepositoryProfile,
): Promise<void> {
  const projectRoot = process.cwd()
  const progress = new ProgressReporter()
  progress.start("evidence report", "loading validated evidence")
  const [investigation, reproducer, proof] = await Promise.all([
    readInvestigationReport(resolve(projectRoot, investigationPath)),
    readReproducer(resolve(projectRoot, values.reproducer)),
    readProofOfFix(resolve(projectRoot, values.proof)),
  ])
  progress.done(formatCount(investigation.experiments.length, "experiment"))
  const repositoryEvidence = await verifiedRepository(repository)

  progress.start("classification", "ownership and redaction")
  const report = buildEvidenceReport({
    investigation,
    paths: {
      investigation: portablePath(projectRoot, investigationPath),
      patch: portablePath(projectRoot, values.patch),
      proof: portablePath(projectRoot, values.proof),
      reproducer: portablePath(projectRoot, values.reproducer),
    },
    proof,
    ...repositoryEvidence,
    reproducer,
  })
  progress.done(report.ownership.classification)

  const outputPath = resolve(projectRoot, values.html)
  progress.start("bundle", "portable offline HTML")
  await writePortableReport(projectRoot, outputPath, report)
  const output = await stat(outputPath)
  progress.done(`${Math.ceil(output.size / 1_024)} KiB`)

  const opened = values.open || await confirmLocalReportOpen()
  if (opened) {
    openLocalReport(outputPath)
  }
  let publishedUrl: string | undefined
  let expiresAt: string | undefined
  if (values.publish) {
    const { confirmReportPublication, publishReport } = await import("../report/publish.js")
    const confirmed = await confirmReportPublication()
    if (confirmed) {
      const apiKey = await requireCredential("solari", {
        forcePrompt: values["prompt-credentials"],
      })
      progress.start("publication", "redacted report")
      const published = await publishReport(outputPath, {
        apiKey,
        baseUrl: process.env.SOLARI_BASE_URL?.trim() ?? "https://api.getsolari.com",
      })
      publishedUrl = published.url
      expiresAt = published.expiresAt
      progress.done("expires automatically")
    } else {
      writeStderr(new TerminalDocument(stderrTheme())
        .entry("warning", "publication cancelled", "The local report is kept.")
        .render())
    }
  }
  writeStderr(reportSummary({
    classification: report.ownership.classification,
    html: values.html,
    kilobytes: Math.ceil(output.size / 1_024),
    status: report.status,
    ...(publishedUrl ? { publishedUrl } : {}),
  }))
  console.log(JSON.stringify({
    outputPath,
    opened,
    status: report.status,
    ownership: report.ownership.classification,
    ...(publishedUrl ? { publishedUrl, expiresAt } : {}),
  }, null, 2))
}
