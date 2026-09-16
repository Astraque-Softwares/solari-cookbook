import type { LanguageModel } from "ai"
import { generateText, Output } from "ai"

import type { SafeSource } from "../investigator/safe-source.js"
import { readSafeRepairContext } from "../investigator/safe-source.js"
import type { InvestigationReport } from "../investigator/schema.js"
import {
  QWEN_INPUT_USD_PER_MILLION,
  QWEN_OUTPUT_USD_PER_MILLION,
} from "../investigator/groq.js"
import { validateCandidatePatch } from "./policy.js"
import type { CandidatePatch } from "./schema.js"
import { candidatePatchSchema } from "./schema.js"

interface PatchGeneratorOptions {
  investigation: InvestigationReport
  maxCostUsd: number
  maxSeconds: number
  model: LanguageModel
  projectRoot: string
  selectedTest?: string
  signal?: AbortSignal
  sourcePaths: string[]
  validateCandidate?: (candidate: CandidatePatch, attempt: number) => Promise<void>
}

export interface CandidateGenerationUsage {
  estimatedCostUsd: number
  inputTokens: number
  outputTokens: number
}

export interface GeneratedCandidatePatch {
  candidate: CandidatePatch
  usage: CandidateGenerationUsage
}

const BASELINE_GROQ_OUTPUT_TOKENS_PER_MINUTE = 1_000

/** Keeps one structured repair request below Groq's baseline organization OTPM ceiling. */
export function candidateOutputTokenBudget(outputTokensPerMinute: number): number {
  if (!Number.isInteger(outputTokensPerMinute) || outputTokensPerMinute < 100) {
    throw new Error("Groq output-token limit must be an integer of at least 100")
  }
  return Math.floor(outputTokensPerMinute * 0.9)
}

function estimatedCost(inputTokens: number, outputTokens: number): number {
  return (
    inputTokens * QWEN_INPUT_USD_PER_MILLION
    + outputTokens * QWEN_OUTPUT_USD_PER_MILLION
  ) / 1_000_000
}

function patchPrompt(investigation: InvestigationReport, sources: SafeSource[]): string {
  return [
    "Propose the smallest application-code repair for this experimentally confirmed failure.",
    "Do not edit the selected test, assertions, test configuration, or dependency configuration.",
    "Do not skip errors, add blanket catches, disable lint rules, or merely increase a timeout.",
    "When control flow changes, remove obsolete timers, flags, branches, and write-only state.",
    "The resulting source must pass strict type-aware ESLint with zero warnings.",
    "Each edit must replace one exact, verbatim source substring. Prefer one cohesive edit.",
    "The repair must preserve normal behavior and make the hostile condition pass.",
    "Investigation evidence:",
    JSON.stringify(investigation, null, 2),
    "Bounded local source context:",
    ...sources.flatMap((source) => [`--- ${source.path}`, source.content]),
  ].join("\n")
}

async function requestCandidate(
  options: PatchGeneratorOptions,
  prompt: string,
): Promise<GeneratedCandidatePatch> {
  let currentPrompt = prompt
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await generateText({
        model: options.model,
        output: Output.object({ schema: candidatePatchSchema }),
        prompt: currentPrompt,
        maxOutputTokens: candidateOutputTokenBudget(BASELINE_GROQ_OUTPUT_TOKENS_PER_MINUTE),
        maxRetries: 2,
        timeout: { totalMs: options.maxSeconds * 1_000 },
        abortSignal: options.signal,
        temperature: 0.2,
      })
      return {
        candidate: result.output,
        usage: {
          estimatedCostUsd: estimatedCost(
            result.usage.inputTokens ?? 0,
            result.usage.outputTokens ?? 0,
          ),
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      }
    } catch (error) {
      if (attempt === 2) {
        throw error
      }
      currentPrompt = [
        prompt,
        "Your previous response did not match the required candidate patch schema.",
        "Return summary, rationale, and 1-3 exact edits with path, before, and after fields.",
      ].join("\n")
    }
  }
  throw new Error("Structured candidate generation exhausted its retry budget")
}

export async function generateCandidatePatch(
  options: PatchGeneratorOptions,
): Promise<GeneratedCandidatePatch> {
  const sources = await readSafeRepairContext(
    options.projectRoot,
    options.selectedTest ?? options.investigation.test,
    options.sourcePaths,
    JSON.stringify(options.investigation),
  )
  const allowedPaths = sources.map((source) => source.path)
  let prompt = patchPrompt(options.investigation, sources)
  const usage: CandidateGenerationUsage = {
    estimatedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const generated = await requestCandidate(options, prompt)
    usage.inputTokens += generated.usage.inputTokens
    usage.outputTokens += generated.usage.outputTokens
    usage.estimatedCostUsd = estimatedCost(usage.inputTokens, usage.outputTokens)
    if (usage.estimatedCostUsd > options.maxCostUsd) {
      throw new Error(
        `Repair generation cost $${usage.estimatedCostUsd.toFixed(4)} exceeded its configured budget`,
      )
    }
    try {
      const candidate = await validateCandidatePatch(
        options.projectRoot,
        options.selectedTest ?? options.investigation.test,
        allowedPaths,
        generated.candidate,
      )
      await options.validateCandidate?.(candidate, attempt)
      return { candidate, usage }
    } catch (error) {
      if (attempt === 2) {
        throw error
      }
      const reason = error instanceof Error ? error.message : "Candidate violated patch policy"
      prompt = [
        prompt,
        "The previous candidate was rejected before execution.",
        `Policy reason: ${reason}`,
        `Rejected candidate: ${JSON.stringify(generated.candidate)}`,
        "Produce a structural application fix that satisfies the original constraints.",
      ].join("\n")
    }
  }
  throw new Error("Candidate generation exhausted its revision budget")
}
