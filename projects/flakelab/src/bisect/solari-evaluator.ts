import type { Sandbox } from "@solarisdk/sandbox"
import { SandboxClient } from "@solarisdk/sandbox"
import { posix } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { deriveTrialSeed } from "../core/plan.js"
import type { Reproducer } from "../reproducer/schema.js"
import { createRevisionArchive } from "./archive.js"
import { classifyFailureProbability, wilsonInterval80 } from "./confidence.js"
import type { Revision, RevisionEvidence } from "./schema.js"
import {
  HistoricalIncompatibility,
  REMOTE_SETUP_ROOT,
  requireCommand,
  runDetachedSetup,
  runDetachedTrial,
} from "./solari-command.js"

const REMOTE_REPOSITORY = "/work/repository"
const REMOTE_ARCHIVE = "/work/flakelab-revision.tar"
const CLIENT_CALL_TIMEOUT_MS = 2 * 60_000
const SANDBOX_TIMEOUT_MS = 15 * 60_000
const PLAYWRIGHT_VERSION = "1.62.1"
const SANDBOX_CREATE_ATTEMPTS = 8
const MAX_INFRASTRUCTURE_ERRORS = 4

interface SolariEvaluatorOptions {
  apiKey: string
  baseUrl: string
  concurrency: number
  maxTrials: number
  minimumFailureRate: number
  projectPath: string
  repositoryRoot: string
  reproducer: Reproducer
  signal?: AbortSignal
}

interface PreparedRevision {
  snapshotId: string
}

interface TrialCounts {
  errors: number
  failed: number
  passed: number
}

function inconclusiveReason(errors: number): string {
  if (errors >= MAX_INFRASTRUCTURE_ERRORS) {
    return `stopped after ${errors} infrastructure errors`
  }
  return "failure probability remained inconclusive within the trial budget"
}

function remoteProjectRoot(projectPath: string): string {
  if (projectPath === "") {
    return REMOTE_REPOSITORY
  }
  const segments = projectPath.replaceAll("\\", "/").split("/")
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new Error("project path must remain inside the Git repository")
  }
  return posix.join(REMOTE_REPOSITORY, ...segments)
}

function validateSelector(selector: string): void {
  const normalized = selector.replaceAll("\\", "/")
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("reproducer test must be a relative path inside the project")
  }
}

function faultEnvironment(reproducer: Reproducer, trialIndex: number): Record<string, string> {
  const fault = reproducer.faults[0]
  return {
    FLAKELAB_FAULT_KIND: "network-delay",
    FLAKELAB_TRIAL_SEED: String(deriveTrialSeed(reproducer.seed, trialIndex)),
    FLAKELAB_NETWORK_DELAY_MS: String(fault.delayMs),
    FLAKELAB_NETWORK_PATTERN: fault.pattern,
    FLAKELAB_REQUEST_FAILURE_STATUS: "0",
  }
}

async function killSandbox(sandbox: Sandbox): Promise<void> {
  sandbox.close()
  await sandbox.kill()
}

export class SolariRevisionEvaluator {
  readonly #client: SandboxClient
  readonly #options: SolariEvaluatorOptions
  readonly #ownedSnapshotIds = new Set<string>()
  readonly #prepared = new Map<string, PreparedRevision>()
  readonly #preparing = new Map<string, Promise<PreparedRevision>>()
  #basePreparation: Promise<PreparedRevision> | undefined

  constructor(options: SolariEvaluatorOptions) {
    validateSelector(options.reproducer.test)
    if (options.maxTrials < options.reproducer.trials || options.maxTrials > 100) {
      throw new Error("max trials must be at least the reproducer trials and at most 100")
    }
    this.#options = options
    this.#client = new SandboxClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      callTimeoutMs: CLIENT_CALL_TIMEOUT_MS,
    })
  }

  async #createSandbox(
    role: "bisect-base" | "bisect-preparation" | "bisect-trial",
    fromSnapshot?: string,
    revision?: string,
  ): Promise<Sandbox> {
    for (let attempt = 1; attempt <= SANDBOX_CREATE_ATTEMPTS; attempt += 1) {
      try {
        return await this.#client.create({
          template: "base",
          ...(fromSnapshot ? { fromSnapshot } : {}),
          cpu: 4,
          memMb: 8_192,
          timeoutMs: SANDBOX_TIMEOUT_MS,
          lifecycle: { onTimeout: "kill" },
          metadata: {
            product: "flakelab",
            role,
            ...(revision ? { revision } : {}),
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Solari sandbox creation failed"
        const transient = /fetch|connection|timeout|503|429|capacity|too many concurrent/iu
          .test(message)
        if (attempt === SANDBOX_CREATE_ATTEMPTS || !transient) {
          throw error
        }
        await delay(attempt * 500, undefined, { signal: this.#options.signal })
      }
    }
    throw new Error("Solari sandbox creation retry budget exhausted")
  }

  async #prepareRevision(revision: Revision): Promise<PreparedRevision> {
    const cached = this.#prepared.get(revision.hash)
    if (cached) {
      return cached
    }
    const pending = this.#preparing.get(revision.hash)
    if (pending) {
      return pending
    }
    const preparation = this.#createPreparedRevision(revision)
    this.#preparing.set(revision.hash, preparation)
    try {
      const prepared = await preparation
      this.#prepared.set(revision.hash, prepared)
      return prepared
    } finally {
      this.#preparing.delete(revision.hash)
    }
  }

  async #createPreparedRevision(revision: Revision): Promise<PreparedRevision> {
    this.#options.signal?.throwIfAborted()
    const archive = await createRevisionArchive(this.#options.repositoryRoot, revision.hash)
    const base = await this.#prepareBase()
    const sandbox = await this.#createSandbox(
      "bisect-preparation",
      base.snapshotId,
      revision.shortHash,
    )
    try {
      await sandbox.connect()
      await sandbox.files.write(REMOTE_ARCHIVE, archive)
      await requireCommand(sandbox, "/work", "repository extraction", "mkdir", [
        "-p",
        REMOTE_REPOSITORY,
      ])
      await requireCommand(sandbox, "/work", "repository extraction", "tar", [
        "-xf",
        REMOTE_ARCHIVE,
        "-C",
        REMOTE_REPOSITORY,
      ])
      const projectRoot = remoteProjectRoot(this.#options.projectPath)
      await requireCommand(sandbox, projectRoot, "historical package manifest", "test", ["-f", "package.json"])
      await requireCommand(sandbox, projectRoot, "historical dependency installation", "pnpm", [
        "install",
        "--frozen-lockfile",
      ])
      await requireCommand(sandbox, projectRoot, "Chromium installation", "pnpm", [
        "exec",
        "playwright",
        "install",
        "chromium",
      ])
      await requireCommand(sandbox, projectRoot, "historical test discovery", "pnpm", [
        "exec",
        "playwright",
        "test",
        this.#options.reproducer.test,
        "--list",
      ])
      const snapshotId = await sandbox.snapshot(`flakelab-bisect-${revision.shortHash}`)
      this.#ownedSnapshotIds.add(snapshotId)
      return { snapshotId }
    } finally {
      await killSandbox(sandbox)
    }
  }

  async #prepareBase(): Promise<PreparedRevision> {
    this.#basePreparation ??= this.#createBaseSnapshot()
    return this.#basePreparation
  }

  async #createBaseSnapshot(): Promise<PreparedRevision> {
    const sandbox = await this.#createSandbox("bisect-base")
    try {
      await sandbox.connect()
      await runDetachedSetup(
        sandbox,
        `npm install --global node@22.14.0 >${REMOTE_SETUP_ROOT}/bootstrap.log 2>&1`
        + ` && npm install --global pnpm@11.6.0 >>${REMOTE_SETUP_ROOT}/bootstrap.log 2>&1`
        + ` && npx --yes playwright@${PLAYWRIGHT_VERSION} install-deps chromium >>${REMOTE_SETUP_ROOT}/bootstrap.log 2>&1`
        + ` && npx --yes playwright@${PLAYWRIGHT_VERSION} install chromium >>${REMOTE_SETUP_ROOT}/bootstrap.log 2>&1`
        + `; printf '%s' $? >${REMOTE_SETUP_ROOT}/bootstrap.exit`,
        this.#options.signal,
      )
      const snapshotId = await sandbox.snapshot("flakelab-bisect-base")
      this.#ownedSnapshotIds.add(snapshotId)
      return { snapshotId }
    } finally {
      await killSandbox(sandbox)
    }
  }

  async #runTrial(snapshotId: string, trialIndex: number): Promise<keyof TrialCounts> {
    this.#options.signal?.throwIfAborted()
    const sandbox = await this.#createSandbox("bisect-trial", snapshotId)
    try {
      await sandbox.connect()
      const exitCode = await runDetachedTrial(
        sandbox,
        remoteProjectRoot(this.#options.projectPath),
        this.#options.reproducer.test,
        faultEnvironment(this.#options.reproducer, trialIndex),
        this.#options.signal,
      )
      return exitCode === 0 ? "passed" : "failed"
    } catch {
      return "errors"
    } finally {
      await killSandbox(sandbox)
    }
  }

  async #runBatch(snapshotId: string, startIndex: number, count: number): Promise<TrialCounts> {
    const outcomes = new Map<number, keyof TrialCounts>()
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (nextIndex < count) {
        const offset = nextIndex
        nextIndex += 1
        outcomes.set(offset, await this.#runTrial(snapshotId, startIndex + offset))
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(this.#options.concurrency, count) },
      worker,
    ))
    const counts: TrialCounts = { errors: 0, failed: 0, passed: 0 }
    for (const outcome of outcomes.values()) {
      counts[outcome] += 1
    }
    return counts
  }

  evaluate = async (revision: Revision): Promise<RevisionEvidence> => {
    const startedAt = Date.now()
    let prepared: PreparedRevision
    try {
      prepared = await this.#prepareRevision(revision)
    } catch (error) {
      if (!(error instanceof HistoricalIncompatibility)) {
        throw error
      }
      return {
        revision,
        classification: "incompatible",
        reason: error.message,
        trials: 0,
        passed: 0,
        failed: 0,
        errors: 0,
        failureRate: 0,
        lowerBound80: 0,
        upperBound80: 1,
        snapshotReuseCount: 0,
        durationMs: Date.now() - startedAt,
      }
    }
    const counts: TrialCounts = { errors: 0, failed: 0, passed: 0 }
    let classification = classifyFailureProbability(0, 0, 0, this.#options.minimumFailureRate)
    while (counts.passed + counts.failed + counts.errors < this.#options.maxTrials) {
      const completed = counts.passed + counts.failed + counts.errors
      const batchSize = Math.min(
        this.#options.reproducer.trials,
        this.#options.maxTrials - completed,
      )
      const batch = await this.#runBatch(prepared.snapshotId, completed, batchSize)
      counts.passed += batch.passed
      counts.failed += batch.failed
      counts.errors += batch.errors
      if (counts.errors >= MAX_INFRASTRUCTURE_ERRORS) {
        break
      }
      const completedTrials = counts.passed + counts.failed + counts.errors
      classification = classifyFailureProbability(
        counts.failed,
        completedTrials,
        counts.errors,
        this.#options.minimumFailureRate,
      )
      if (classification !== "inconclusive") {
        break
      }
    }
    const trials = counts.passed + counts.failed + counts.errors
    const validTrials = counts.passed + counts.failed
    const interval = wilsonInterval80(counts.failed, validTrials)
    return {
      revision,
      classification,
      reason: classification === "inconclusive"
        ? inconclusiveReason(counts.errors)
        : `80% confidence interval is ${interval.lower.toFixed(3)}–${interval.upper.toFixed(3)}`,
      trials,
      passed: counts.passed,
      failed: counts.failed,
      errors: counts.errors,
      failureRate: validTrials === 0 ? 0 : counts.failed / validTrials,
      lowerBound80: interval.lower,
      upperBound80: interval.upper,
      snapshotReuseCount: Math.max(0, trials - 1),
      durationMs: Date.now() - startedAt,
    }
  }

  async #deleteSnapshot(snapshotId: string): Promise<Error | undefined> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.#client.deleteSnapshot(snapshotId)
        return undefined
      } catch (error) {
        const message = error instanceof Error ? error.message : "snapshot cleanup failed"
        if (attempt < 3 && /live children|has children|conflict/iu.test(message)) {
          await delay(attempt * 500)
        } else {
          return error instanceof Error ? error : new Error(message)
        }
      }
    }
    return new Error("snapshot cleanup retry budget exhausted")
  }

  async dispose(): Promise<void> {
    let cleanupError: Error | undefined
    for (const snapshotId of [...this.#ownedSnapshotIds].reverse()) {
      cleanupError ??= await this.#deleteSnapshot(snapshotId)
    }
    this.#prepared.clear()
    this.#ownedSnapshotIds.clear()
    if (cleanupError) {
      throw cleanupError
    }
  }
}
