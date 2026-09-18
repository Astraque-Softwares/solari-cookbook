import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"

import { readInvestigationReport } from "../investigator/file.js"
import { createGroqInvestigatorModel } from "../investigator/groq.js"
import {
  CandidateGenerationFailure,
  generateCandidatePatch,
} from "../repair/generator.js"
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
import {
  candidateInvalidProofSchema,
  proofOfFixSchema,
} from "../repair/schema.js"
import type {
  CandidateGenerationEvidence,
  CandidateInvalidProof,
  ProofOfFix,
} from "../repair/schema.js"
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

export type RepairResult = {
  outcome: "candidate-invalid"
  proof: CandidateInvalidProof
  usage: CandidateGenerationUsage
} | {
  outcome: "candidate-proven" | "candidate-rejected"
  proof: ProofOfFix
  usage: CandidateGenerationUsage
}

export interface RepairRuntime {
  artifactDirectory?: string
  beforeProviderRequest?: () => void
  maxCandidateAttempts?: number
  onCandidateProgress?: (evidence: CandidateGenerationEvidence) => Promise<void>
}

type RepairOperationResult = Extract<RepairResult, { outcome: "candidate-invalid" }> | {
  diff: string
  outcome: "proof-complete"
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

function repairInvocationRoot(repository?: RepositoryProfile): string {
  return repository?.invocationRoot ?? process.cwd()
}

function portableArtifactPath(root: string, path: string): string {
  const portable = relative(root, path).replaceAll("\\", "/")
  if (portable === ".." || portable.startsWith("../") || isAbsolute(portable)) {
    throw new Error("Candidate attempt artifacts must stay inside the repository workspace")
  }
  return portable
}

function portableCandidateEvidence(
  root: string,
  value: CandidateGenerationEvidence,
): CandidateGenerationEvidence {
  const portable = (path: string): string => portableArtifactPath(root, path)
  return {
    ...value,
    artifactPaths: value.artifactPaths.map(portable),
    attempts: value.attempts.map((attempt) => ({
      ...attempt,
      artifactPaths: {
        candidate: portable(attempt.artifactPaths.candidate),
        diff: attempt.artifactPaths.diff ? portable(attempt.artifactPaths.diff) : null,
        validation: portable(attempt.artifactPaths.validation),
      },
    })),
  }
}

function candidateInvalidProof(
  patchPath: string,
  evidence: CandidateGenerationEvidence,
): CandidateInvalidProof {
  const code = evidence.finalRejection?.code
  return candidateInvalidProofSchema.parse({
    candidateGeneration: evidence,
    execution: "local-validation",
    outcome: "candidate-invalid",
    patchAccepted: false,
    patchPath,
    resources: { created: 0, live: 0, released: 0 },
    sourceLocations: [],
    staticChecks: {
      lint: code === "lint-new-diagnostic" ? false : null,
      typecheck: code === "typecheck-new-diagnostic" ? false : null,
    },
    staticDiagnostics: {},
  })
}

function formatInvalidCandidate(evidence: CandidateGenerationEvidence, artifactDirectory: string): string {
  const lines = [
    `Candidate generation exhausted ${formatCount(evidence.attemptCount, "attempt")}.`,
    ...evidence.attempts.map((attempt) =>
      `Attempt ${attempt.attempt}: ${attempt.rejection?.code ?? attempt.outcome}.`),
    "No candidate passed local policy.",
    "No Solari resource was allocated.",
    `Attempt evidence was saved under ${artifactDirectory}.`,
  ]
  return lines.join("\n")
}

export async function repair(
  investigationPath: string,
  values: RepairOptions,
  repository?: RepositoryProfile,
  runtime: RepairRuntime = {},
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
      {
        label: "Candidate attempts",
        value: `at most ${runtime.maxCandidateAttempts ?? 2}`,
      },
    ],
    stage: "Groq repair candidate and isolated Solari proof",
  }, stderrTheme()))
  const invocationRoot = repairInvocationRoot(repository)
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
  const patchPath = resolve(invocationRoot, values.patch)
  const proofPath = resolve(invocationRoot, values.proof)
  await prepareRepairArtifactDirectories(patchPath, proofPath)
  const candidateDirectory = resolve(
    invocationRoot,
    runtime.artifactDirectory ?? values.artifacts ?? ".flakelab/runs",
    "candidates",
  )
  await mkdir(candidateDirectory, { recursive: true })
  const progress = new ProgressReporter()
  progress.start("repair candidate", "policy-bounded generation")
  const result: RepairOperationResult = await withInterruption(async (signal) => {
    let generated
    try {
      generated = await generateCandidatePatch({
        artifactDirectory: candidateDirectory,
        beforeProviderRequest: runtime.beforeProviderRequest,
        investigation,
        maxCostUsd: positiveNumberOption(values["max-cost"], "max-cost"),
        maxAttempts: runtime.maxCandidateAttempts,
        maxSeconds: integerOption(values["max-seconds"], "max-seconds"),
        model: createGroqInvestigatorModel(apiKey, values.model),
        onProgress: async (evidence) => runtime.onCandidateProgress?.(
          portableCandidateEvidence(invocationRoot, evidence),
        ),
        projectRoot: sourceRoot,
        selectedTest,
        signal,
        sourcePaths,
        validateCandidate: async (candidate) => preflightCandidate(profile, candidate, signal),
      })
    } catch (error) {
      if (!(error instanceof CandidateGenerationFailure)
        || !error.candidateInvalid || !error.evidence) throw error
      const candidateEvidence = portableCandidateEvidence(invocationRoot, error.evidence)
      const invalidProof = candidateInvalidProof(values.patch, candidateEvidence)
      progress.done(`exhausted ${candidateEvidence.attemptCount} attempts`)
      await writeFile(proofPath, `${JSON.stringify(invalidProof, null, 2)}\n`, "utf8")
      writeStderr(formatInvalidCandidate(candidateEvidence, portableArtifactPath(
        invocationRoot,
        candidateDirectory,
      )))
      console.log(JSON.stringify({
        proofPath,
        usage: candidateEvidence.usage,
        ...invalidProof,
      }, null, 2))
      process.exitCode = 1
      return {
        outcome: "candidate-invalid" as const,
        proof: invalidProof,
        usage: candidateEvidence.usage,
      }
    }
    progress.done(formatCount(generated.candidate.edits.length, "source edit"))
    const previewDiff = await createCandidateDiff(sourceRoot, generated.candidate)
    await writeFile(patchPath, previewDiff, "utf8")
    if (terminalActivityEnabled()) {
      writeStderr(formatCandidateDiff(previewDiff, values.patch, stderrTheme()))
    }
    progress.start("isolated proof", "Solari microVM")
    const solariApiKey = await requireCredential("solari", {
      forcePrompt: values["prompt-credentials"],
    })
    const baseUrl = process.env.SOLARI_BASE_URL?.trim() ?? "https://api.getsolari.com"
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
    return {
      ...validated,
      outcome: "proof-complete" as const,
      proof: proofOfFixSchema.parse({
        ...validated.proof,
        candidateGeneration: portableCandidateEvidence(invocationRoot, generated.evidence),
      }),
      usage: generated.usage,
    }
  })
  if (result.outcome === "candidate-invalid") return result
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
  return {
    outcome: result.proof.patchAccepted ? "candidate-proven" : "candidate-rejected",
    proof: result.proof,
    usage: result.usage,
  }
}
