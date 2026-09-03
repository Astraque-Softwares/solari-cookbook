import { discover } from "./discover.js"
import { investigate } from "./investigate.js"
import type { CliValues } from "./options.js"
import { repair } from "./repair.js"
import { replay } from "./replay.js"
import { generateReport } from "./report.js"

function ensureSuccessfulStage(stage: string): void {
  if (process.exitCode && process.exitCode !== 0) {
    throw new Error(`${stage} did not produce acceptable evidence`)
  }
}

export async function prove(target: string, values: CliValues): Promise<void> {
  process.stderr.write("FlakeLab · Full proof uses Groq and disposable Solari resources.\n")
  await discover(target, values)
  await replay(values.output, values)
  ensureSuccessfulStage("Reproducer replay")
  await investigate(target, values)
  await repair(values.report, values)
  ensureSuccessfulStage("Candidate repair")
  await generateReport(values.report, values)
}
