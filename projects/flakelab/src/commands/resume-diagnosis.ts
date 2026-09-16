import { isAbsolute, relative, resolve, sep } from "node:path"

import { readDiagnosisCheckpoint } from "../diagnosis/checkpoint.js"
import {
  restoreDiagnosisContext,
  restoreDiagnosisOptions,
} from "../diagnosis/run-state.js"
import { discoverRepositoryProfile } from "../project/profile.js"
import type { DiagnosisContext } from "../diagnosis/run-state.js"
import { diagnose } from "./diagnose.js"

function confinedProjectPath(projectRoot: string, path: string): void {
  const projectRelative = relative(projectRoot, resolve(projectRoot, path))
  if (projectRelative === ".." || projectRelative.startsWith(`..${sep}`)
    || isAbsolute(projectRelative)) {
    throw new Error("Diagnosis checkpoint artifact paths must stay inside the current project")
  }
}

function validateResumePaths(context: DiagnosisContext): void {
  const { checkpoint, projectRoot, target, values } = context
  const paths = [values.artifacts, values.baseline, values.evidence, values.html, values.patch,
    values.proof, values.report, values.reproducer, target, ...Object.values(checkpoint.artifacts)]
  for (const path of paths) {
    if (path) confinedProjectPath(projectRoot, path)
  }
}

export async function resumeSavedDiagnosis(path: string): Promise<void> {
  const projectRoot = process.cwd()
  const artifactPath = resolve(projectRoot, path)
  const checkpoint = await readDiagnosisCheckpoint(artifactPath)
  const target = checkpoint.input.target ?? undefined
  if (target && !checkpoint.repository) {
    await diagnose(target, restoreDiagnosisOptions(checkpoint))
    return
  }
  if (target && checkpoint.lastError?.includes("Repository inputs changed during")) {
    await diagnose(target, {
      ...restoreDiagnosisOptions(checkpoint),
      discover: true,
      investigate: false,
      repair: false,
      source: [],
    })
    return
  }
  const repository = target ? await discoverRepositoryProfile({
    artifactDirectory: checkpoint.input.options.artifacts,
    config: checkpoint.input.options.config,
    invocationRoot: projectRoot,
    target,
  }) : undefined
  const context = restoreDiagnosisContext(artifactPath, checkpoint, projectRoot, repository)
  validateResumePaths(context)
  const { continueSavedDiagnosis } = await import("./diagnose.js")
  await continueSavedDiagnosis(context)
}
