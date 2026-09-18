import { readFile } from "node:fs/promises"

import { repairEvidenceSchema } from "./schema.js"
import type { RepairEvidence } from "./schema.js"

export async function readProofOfFix(path: string): Promise<RepairEvidence> {
  return repairEvidenceSchema.parse(JSON.parse(await readFile(path, "utf8")))
}
