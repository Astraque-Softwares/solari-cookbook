import { readFile } from "node:fs/promises"

import { proofOfFixSchema } from "./schema.js"
import type { ProofOfFix } from "./schema.js"

export async function readProofOfFix(path: string): Promise<ProofOfFix> {
  return proofOfFixSchema.parse(JSON.parse(await readFile(path, "utf8")))
}
