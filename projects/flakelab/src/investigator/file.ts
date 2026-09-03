import { readFile } from "node:fs/promises"

import type { InvestigationReport } from "./schema.js"
import { investigationReportSchema } from "./schema.js"

export async function readInvestigationReport(filePath: string): Promise<InvestigationReport> {
  const contents = await readFile(filePath, "utf8")
  return investigationReportSchema.parse(JSON.parse(contents))
}
