import { config } from "dotenv"
import { stat } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { readInvestigationReport } from "../investigator/file.js"
import { readProofOfFix } from "../repair/file.js"
import { writePortableReport } from "../report/bundle.js"
import { buildEvidenceReport } from "../report/model.js"
import { openLocalReport } from "../report/open.js"
import { confirmReportPublication, publishReport } from "../report/publish.js"
import { readReproducer } from "../reproducer/file.js"
import { ProgressReporter } from "../ui/progress.js"
import type { CliValues } from "./options.js"

function portablePath(projectRoot: string, path: string): string {
  const portable = relative(projectRoot, resolve(projectRoot, path)).replaceAll("\\", "/")
  if (portable.startsWith("../") || portable === "..") {
    throw new Error("Report artifacts must stay inside the project")
  }
  return portable
}

export async function generateReport(
  investigationPath: string,
  values: CliValues,
): Promise<void> {
  const projectRoot = process.cwd()
  const progress = new ProgressReporter()
  progress.start("Loading validated evidence")
  const [investigation, reproducer, proof] = await Promise.all([
    readInvestigationReport(resolve(projectRoot, investigationPath)),
    readReproducer(resolve(projectRoot, values.reproducer)),
    readProofOfFix(resolve(projectRoot, values.proof)),
  ])
  progress.done(`${investigation.experiments.length} experiments`)

  progress.start("Classifying ownership and redacting evidence")
  const report = buildEvidenceReport({
    investigation,
    paths: {
      investigation: portablePath(projectRoot, investigationPath),
      patch: portablePath(projectRoot, values.patch),
      proof: portablePath(projectRoot, values.proof),
      reproducer: portablePath(projectRoot, values.reproducer),
    },
    proof,
    reproducer,
  })
  progress.done(report.ownership.classification)

  const outputPath = resolve(projectRoot, values.html)
  progress.start("Bundling portable evidence report")
  await writePortableReport(projectRoot, outputPath, report)
  const output = await stat(outputPath)
  progress.done(`${Math.ceil(output.size / 1_024)} KiB`)

  if (values.open) {
    openLocalReport(outputPath)
  }
  let publishedUrl: string | undefined
  let expiresAt: string | undefined
  if (values.publish) {
    const confirmed = await confirmReportPublication()
    if (confirmed) {
      config({ quiet: true })
      const apiKey = process.env.SOLARI_API_KEY?.trim()
      if (!apiKey) {
        throw new Error("SOLARI_API_KEY is required to publish a report")
      }
      progress.start("Publishing the redacted report")
      const published = await publishReport(outputPath, {
        apiKey,
        baseUrl: process.env.SOLARI_BASE_URL?.trim() ?? "https://api.getsolari.com",
      })
      publishedUrl = published.url
      expiresAt = published.expiresAt
      progress.done("expires automatically")
    } else {
      process.stderr.write("Publication cancelled · local report kept\n")
    }
  }
  console.log(JSON.stringify({
    outputPath,
    opened: values.open,
    status: report.status,
    ownership: report.ownership.classification,
    ...(publishedUrl ? { publishedUrl, expiresAt } : {}),
  }, null, 2))
}
