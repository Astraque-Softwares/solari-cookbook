import type { LanguageModel } from "ai"
import { generateText, Output } from "ai"

import type { SafeSource } from "../investigator/safe-source.js"
import { readSafeTestContext } from "../investigator/safe-source.js"
import type { InvestigationReport } from "../investigator/schema.js"
import { validateCandidatePatch } from "./policy.js"
import type { CandidatePatch } from "./schema.js"
import { candidatePatchSchema } from "./schema.js"

interface PatchGeneratorOptions {
  investigation: InvestigationReport
  maxSeconds: number
  model: LanguageModel
  projectRoot: string
  signal?: AbortSignal
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
): Promise<CandidatePatch> {
  let currentPrompt = prompt
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await generateText({
        model: options.model,
        output: Output.object({ schema: candidatePatchSchema }),
        prompt: currentPrompt,
        maxOutputTokens: 1_500,
        maxRetries: 2,
        timeout: { totalMs: options.maxSeconds * 1_000 },
        abortSignal: options.signal,
        temperature: 0.2,
      })
      return result.output
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
): Promise<CandidatePatch> {
  const sources = await readSafeTestContext(options.projectRoot, options.investigation.test)
  const allowedPaths = sources.map((source) => source.path)
  let prompt = patchPrompt(options.investigation, sources)
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const candidate = await requestCandidate(options, prompt)
    try {
      return await validateCandidatePatch(
        options.projectRoot,
        options.investigation.test,
        allowedPaths,
        candidate,
      )
    } catch (error) {
      if (attempt === 2) {
        throw error
      }
      const reason = error instanceof Error ? error.message : "Candidate violated patch policy"
      prompt = [
        prompt,
        "The previous candidate was rejected before execution.",
        `Policy reason: ${reason}`,
        `Rejected candidate: ${JSON.stringify(candidate)}`,
        "Produce a structural application fix that satisfies the original constraints.",
      ].join("\n")
    }
  }
  throw new Error("Candidate generation exhausted its revision budget")
}
