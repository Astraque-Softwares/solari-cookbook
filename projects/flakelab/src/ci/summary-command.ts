import { parse } from "yaml"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { parseArgs } from "node:util"

import { investigationReportSchema } from "../investigator/schema.js"
import { proofOfFixSchema } from "../repair/schema.js"
import { reproducerSchema } from "../reproducer/schema.js"
import { buildJobSummary } from "./job-summary.js"

async function readJson(path: string): Promise<object> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as object
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      investigation: { type: "string", default: "flakelab.investigation.json" },
      output: { type: "string", default: ".flakelab/job-summary.md" },
      proof: { type: "string", default: "flakelab.proof.json" },
      reproducer: { type: "string", default: "flakelab.repro.yaml" },
    },
  })
  const summary = buildJobSummary({
    artifactUrl: process.env.FLAKELAB_ARTIFACT_URL,
    investigation: investigationReportSchema.parse(await readJson(values.investigation)),
    proof: proofOfFixSchema.parse(await readJson(values.proof)),
    reproducer: reproducerSchema.parse(parse(await readFile(resolve(values.reproducer), "utf8"))),
  })
  const outputPath = resolve(values.output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, summary, "utf8")
  const githubSummary = process.env.GITHUB_STEP_SUMMARY
  if (githubSummary) {
    if (!isAbsolute(githubSummary) || /[\r\n\0]/u.test(githubSummary)) {
      throw new Error("GITHUB_STEP_SUMMARY must be an absolute file path")
    }
    await appendFile(githubSummary, summary, "utf8")
  }
  console.log(JSON.stringify({ outputPath }, null, 2))
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : "Job-summary generation failed")
  process.exitCode = 1
}
