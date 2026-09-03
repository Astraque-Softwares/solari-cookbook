import { config } from "dotenv"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { statisticalBisect } from "../bisect/engine.js"
import { resolveGitHistory } from "../bisect/git.js"
import { bisectReportSchema } from "../bisect/schema.js"
import { SolariRevisionEvaluator } from "../bisect/solari-evaluator.js"
import { readReproducer } from "../reproducer/file.js"
import { withSolariTransport } from "../solari/transport.js"
import { ProgressReporter } from "../ui/progress.js"
import type { CliValues } from "./options.js"
import { integerOption, rateOption, withInterruption } from "./options.js"

export async function bisect(values: CliValues): Promise<void> {
  config({ quiet: true })
  const apiKey = process.env.SOLARI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("SOLARI_API_KEY is required to evaluate revisions in isolation")
  }
  if (!values.good) {
    throw new Error("--good is required")
  }
  const projectRoot = process.cwd()
  const reproducer = await readReproducer(resolve(projectRoot, values.reproducer))
  const history = await resolveGitHistory(projectRoot, values.good, values.bad)
  const reportPath = resolve(projectRoot, values["bisect-report"])
  const minimumFailureRate = rateOption(values["min-rate"])
  const parallelism = integerOption(values["bisect-parallelism"], "bisect-parallelism")
  const totalConcurrency = integerOption(values.concurrency, "concurrency")
  const revisionConcurrency = Math.max(1, Math.floor(totalConcurrency / parallelism))
  const progress = new ProgressReporter()
  progress.start(`Evaluating ${history.revisions.length} historical revisions in Solari`)
  const report = await withSolariTransport(async () =>
    withInterruption(async (signal) => {
      const evaluator = new SolariRevisionEvaluator({
        apiKey,
        baseUrl: process.env.SOLARI_BASE_URL?.trim() ?? "https://api.getsolari.com",
        concurrency: revisionConcurrency,
        maxTrials: integerOption(values["max-trials"], "max-trials"),
        minimumFailureRate,
        projectPath: history.projectPath,
        repositoryRoot: history.repositoryRoot,
        reproducer,
        signal,
      })
      try {
        return await statisticalBisect({
          evaluate: evaluator.evaluate,
          minimumFailureRate,
          parallelism,
          revisions: history.revisions,
        })
      } finally {
        await evaluator.dispose()
      }
    }),
  )
  const validated = bisectReportSchema.parse(report)
  await writeFile(reportPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8")
  progress.done(validated.exact
    ? `first failing commit ${validated.firstFailingCommit?.shortHash ?? "unavailable"}`
    : `earliest proven bad commit ${validated.earliestKnownBadCommit.shortHash}`)
  console.log(JSON.stringify({ reportPath, ...validated }, null, 2))
  if (!validated.exact) {
    process.exitCode = 2
  }
}
