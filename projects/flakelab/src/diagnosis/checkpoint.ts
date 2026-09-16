import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { DiagnosisArtifact } from "./schema.js"
import { diagnosisArtifactSchema, diagnosisInputSchema } from "./schema.js"

export type DiagnosisPhase = "complete" | "discover" | "investigate" | "repair"

export function diagnosisInputHash(input: DiagnosisArtifact["input"]): string {
  const canonicalInput = diagnosisInputSchema.parse(input)
  return createHash("sha256").update(JSON.stringify(canonicalInput)).digest("hex")
}

export function nextDiagnosisPhase(checkpoint: DiagnosisArtifact): DiagnosisPhase {
  const workflow = checkpoint.input.options
  const phases: Record<DiagnosisArtifact["stage"], DiagnosisPhase> = {
    investigated: workflow.repair ? "repair" : "complete",
    "no-signal-observed": "complete",
    observed: workflow.discover || workflow.investigate || workflow.repair
      ? "discover"
      : "complete",
    "repair-proven": "complete",
    "repair-rejected": "complete",
    "reproducer-created": workflow.investigate || workflow.repair
      ? "investigate"
      : "complete",
  }
  return phases[checkpoint.stage]
}

export async function readDiagnosisCheckpoint(path: string): Promise<DiagnosisArtifact> {
  const checkpoint = diagnosisArtifactSchema.parse(JSON.parse(await readFile(path, "utf8")))
  if (diagnosisInputHash(checkpoint.input) !== checkpoint.inputHash) {
    throw new Error("Diagnosis checkpoint inputs do not match its integrity hash")
  }
  return checkpoint
}

export async function writeDiagnosisCheckpoint(
  path: string,
  checkpoint: DiagnosisArtifact,
): Promise<void> {
  const validated = diagnosisArtifactSchema.parse(checkpoint)
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
