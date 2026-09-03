import { config } from "dotenv"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { readInvestigationReport } from "../investigator/file.js"
import { createGroqInvestigatorModel } from "../investigator/groq.js"
import { generateCandidatePatch } from "../repair/generator.js"
import { validateProofOfFix } from "../repair/validator.js"
import { readReproducer } from "../reproducer/file.js"
import { withSolariTransport } from "../solari/transport.js"
import { ProgressReporter } from "../ui/progress.js"
import type { CliValues } from "./options.js"
import { integerOption, withInterruption } from "./options.js"

export async function repair(investigationPath: string, values: CliValues): Promise<void> {
  config({ quiet: true })
  const apiKey = process.env.GROQ_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is required to generate a candidate repair")
  }
  const solariApiKey = process.env.SOLARI_API_KEY?.trim()
  if (!solariApiKey) {
    throw new Error("SOLARI_API_KEY is required to validate candidate code in isolation")
  }
  const baseUrl = process.env.SOLARI_BASE_URL?.trim() ?? "https://api.getsolari.com"
  const projectRoot = process.cwd()
  const investigation = await readInvestigationReport(resolve(projectRoot, investigationPath))
  const reproducer = await readReproducer(resolve(projectRoot, values.reproducer))
  const patchPath = resolve(projectRoot, values.patch)
  const proofPath = resolve(projectRoot, values.proof)
  const progress = new ProgressReporter()
  progress.start("Generating a policy-bounded candidate")
  const result = await withInterruption(async (signal) => {
    const candidate = await generateCandidatePatch({
      investigation,
      maxSeconds: integerOption(values["max-seconds"], "max-seconds"),
      model: createGroqInvestigatorModel(apiKey, values.model),
      projectRoot,
      signal,
    })
    progress.done(`${candidate.edits.length} source edit${candidate.edits.length === 1 ? "" : "s"}`)
    progress.start("Proving the candidate in a Solari microVM")
    return withSolariTransport(async () => validateProofOfFix(
      {
        apiKey: solariApiKey,
        baseUrl,
        candidate,
        concurrency: integerOption(values.concurrency, "concurrency"),
        projectRoot,
        reproducer,
        signal,
      },
      patchPath,
    ))
  })
  progress.done(result.proof.patchAccepted ? "accepted" : "rejected")
  await writeFile(patchPath, result.diff, "utf8")
  await writeFile(proofPath, `${JSON.stringify(result.proof, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ proofPath, ...result.proof }, null, 2))
  if (!result.proof.patchAccepted) {
    process.exitCode = 1
  }
}
