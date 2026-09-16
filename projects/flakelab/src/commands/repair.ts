import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"

import { readInvestigationReport } from "../investigator/file.js"
import { createGroqInvestigatorModel } from "../investigator/groq.js"
import { generateCandidatePatch } from "../repair/generator.js"
import type { CandidateGenerationUsage } from "../repair/generator.js"
import { validateProofOfFix } from "../repair/validator.js"
import { readReproducer } from "../reproducer/file.js"
import { requireCredential } from "../security/credentials.js"
import { withSolariTransport } from "../solari/transport.js"
import { formatProviderBoundary } from "../ui/boundary.js"
import { writeStderr } from "../ui/console.js"
import { formatCount } from "../ui/format.js"
import { formatCandidateDiff } from "../ui/diff.js"
import { ProgressReporter } from "../ui/progress.js"
import { stderrTheme, terminalActivityEnabled } from "../ui/theme.js"
import { formatProofSummary } from "../repair/summary.js"
import type { ProofOfFix } from "../repair/schema.js"
import { createCandidateDiff } from "../repair/workspace.js"
import type { RepositoryProfile } from "../project/schema.js"
import {
  approveRepositorySources,
  assertRepositoryUnchanged,
  discoverRepositoryProfile,
  writeRepositoryProfile,
} from "../project/profile.js"
import { preflightCandidate } from "../repair/preflight.js"
import type { RepairOptions } from "./options.js"
import { integerOption, positiveNumberOption, withInterruption } from "./options.js"

export interface RepairResult {
  proof: ProofOfFix
  usage: CandidateGenerationUsage
}

export async function prepareRepairArtifactDirectories(
  patchPath: string,
  proofPath: string,
): Promise<void> {
  await Promise.all([
    mkdir(dirname(patchPath), { recursive: true }),
    mkdir(dirname(proofPath), { recursive: true }),
  ])
}

function workspacePath(workspace: string, projectRoot: string, selectedPath: string): string {
  const absolute = resolve(projectRoot, selectedPath)
  const path = relative(workspace, absolute).replaceAll("\\", "/")
  if (path.startsWith("..") || isAbsolute(path)) {
    throw new Error(`Approved source must stay inside the repository workspace: ${selectedPath}`)
  }
  return path
}

export async function repair(
  investigationPath: string,
  values: RepairOptions,
  repository?: RepositoryProfile,
): Promise<RepairResult> {
  writeStderr(formatProviderBoundary({
    credentials: ["GROQ_API_KEY", "SOLARI_API_KEY"],
    detail: "Candidate generation sends the investigation summary and approved source"
      + " files to Groq. Proof runs in one disposable Solari microVM that is released"
      + " when the run ends.",
    rows: [
      { label: "Model", value: values.model },
      { label: "Cost ceiling", value: `$${values["max-cost"]}` },
      { label: "Time ceiling", value: `${values["max-seconds"]}s` },
      { label: "Approved source", value: formatCount(values.source.length, "file") },
    ],
    stage: "Groq repair candidate and isolated Solari proof",
  }, stderrTheme()))
  const invocationRoot = repository?.invocationRoot ?? process.cwd()
  const investigation = await readInvestigationReport(resolve(invocationRoot, investigationPath))
  const profile = repository ?? await discoverRepositoryProfile({
    artifactDirectory: ".flakelab/runs",
    invocationRoot,
    target: investigation.test,
  })
  await writeRepositoryProfile(profile, ".flakelab/runs")
  const projectRoot = profile.executionRoot
  const sourceRoot = profile.workspaceRoot
  const selectedTest = workspacePath(sourceRoot, projectRoot, investigation.test)
  const sourcePaths = values.source.map((source) => workspacePath(sourceRoot, invocationRoot, source))
  await approveRepositorySources(
    profile,
    sourcePaths.map((source) => resolve(sourceRoot, source)),
  )
  await writeRepositoryProfile(profile, ".flakelab/runs")
  const reproducer = await readReproducer(resolve(invocationRoot, values.reproducer))
  const apiKey = await requireCredential("groq", {
    forcePrompt: values["prompt-credentials"],
  })
  const solariApiKey = await requireCredential("solari", {
    forcePrompt: values["prompt-credentials"],
  })
  const baseUrl = process.env.SOLARI_BASE_URL?.trim() ?? "https://api.getsolari.com"
  const patchPath = resolve(invocationRoot, values.patch)
  const proofPath = resolve(invocationRoot, values.proof)
  await prepareRepairArtifactDirectories(patchPath, proofPath)
  const candidateDirectory = resolve(invocationRoot, ".flakelab/runs/candidates")
  await mkdir(candidateDirectory, { recursive: true })
  const progress = new ProgressReporter()
  progress.start("repair candidate", "policy-bounded generation")
  const result = await withInterruption(async (signal) => {
    const generated = await generateCandidatePatch({
      investigation,
      maxCostUsd: positiveNumberOption(values["max-cost"], "max-cost"),
      maxSeconds: integerOption(values["max-seconds"], "max-seconds"),
      model: createGroqInvestigatorModel(apiKey, values.model),
      projectRoot: sourceRoot,
      selectedTest,
      signal,
      sourcePaths,
      validateCandidate: async (candidate, attempt) => {
        const diff = await createCandidateDiff(sourceRoot, candidate)
        const attemptPath = resolve(candidateDirectory, `attempt-${attempt}.diff`)
        await writeFile(attemptPath, diff, "utf8")
        try {
          const validation = await preflightCandidate(profile, candidate, signal)
          await writeFile(
            resolve(candidateDirectory, `attempt-${attempt}.validation.json`),
            `${JSON.stringify({ outcome: "valid", ...validation }, null, 2)}\n`,
            "utf8",
          )
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : "Candidate preflight failed"
          await writeFile(
            resolve(candidateDirectory, `attempt-${attempt}.validation.json`),
            `${JSON.stringify({ outcome: "candidate-invalid", reason }, null, 2)}\n`,
            "utf8",
          )
          throw new Error(`Candidate preflight failed: ${reason}`, { cause })
        }
      },
    })
    progress.done(formatCount(generated.candidate.edits.length, "source edit"))
    const previewDiff = await createCandidateDiff(sourceRoot, generated.candidate)
    await writeFile(patchPath, previewDiff, "utf8")
    if (terminalActivityEnabled()) {
      writeStderr(formatCandidateDiff(previewDiff, values.patch, stderrTheme()))
    }
    progress.start("isolated proof", "Solari microVM")
    await assertRepositoryUnchanged(profile)
    const validated = await withSolariTransport(async () => validateProofOfFix(
      {
        apiKey: solariApiKey,
        baseUrl,
        candidate: generated.candidate,
        candidateRoot: sourceRoot,
        concurrency: integerOption(values.concurrency, "concurrency"),
        projectRoot,
        repository: profile,
        reproducer,
        signal,
      },
      patchPath,
    ))
    return { ...validated, usage: generated.usage }
  })
  progress.done(result.proof.patchAccepted ? "candidate accepted" : "candidate rejected")
  await writeFile(patchPath, result.diff, "utf8")
  await writeFile(proofPath, `${JSON.stringify(result.proof, null, 2)}\n`, "utf8")
  writeStderr(formatProofSummary(
    result.proof,
    { patch: values.patch, proof: values.proof },
    stderrTheme(),
  ))
  console.log(JSON.stringify({ proofPath, usage: result.usage, ...result.proof }, null, 2))
  if (!result.proof.patchAccepted) {
    process.exitCode = 1
  }
  return { proof: result.proof, usage: result.usage }
}
