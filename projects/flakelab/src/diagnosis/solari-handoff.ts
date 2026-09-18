import { createInterface } from "node:readline/promises"

import { formatSeconds } from "../ui/format.js"
import { sanitizeLine } from "../ui/text.js"
import type { DiscoveryBudget } from "./discovery-budget.js"

type AskQuestion = (question: string, completions?: string[]) => Promise<string>
export interface SourceSuggestion {
  path: string
  reason: string
}
type DiscoverSources = () => Promise<SourceSuggestion[]>

export interface SolariHandoffOptions {
  ask?: AskQuestion
  discoverSources?: DiscoverSources
  environment?: NodeJS.ProcessEnv
  inputIsTTY?: boolean
  outputIsTTY?: boolean
}

export interface SolariProofRequest {
  maxSeconds: number
  sources: string[]
}

function interactive(options: SolariHandoffOptions): boolean {
  const environment = options.environment ?? process.env
  return (options.inputIsTTY ?? Boolean(process.stdin.isTTY))
    && (options.outputIsTTY ?? Boolean(process.stderr.isTTY))
    && !environment.CI
}

async function askInTerminal(question: string, completions: string[] = []): Promise<string> {
  const completer = (line: string): [string[], string] => {
    const matches = completions.filter((candidate) => candidate.startsWith(line))
    return [matches.length > 0 ? matches : completions, line]
  }
  const prompt = createInterface({
    completer,
    input: process.stdin,
    output: process.stderr,
  })
  try {
    return await prompt.question(question)
  } finally {
    prompt.close()
  }
}

function accepted(answer: string): boolean {
  const normalized = answer.trim().toLowerCase()
  return normalized === "y" || normalized === "yes"
}

function acceptedByDefault(answer: string): boolean {
  return answer.trim() === "" || accepted(answer)
}

function candidateQuestion(candidates: SourceSuggestion[]): string {
  const choices = candidates
    .map((candidate, index) => `  ${index + 1}. ${sanitizeLine(candidate.path)}`
      + ` — ${sanitizeLine(candidate.reason)}`)
    .join("\n")
  return `Suggested application sources:\n${choices}\n`
    + "Select a number or type a path (Tab shows matches; Enter cancels): "
}

function selectedSource(answer: string, candidates: SourceSuggestion[]): string | null {
  const value = answer.trim()
  if (!value) {
    return null
  }
  const selectedIndex = /^\d+$/u.test(value) ? Number(value) - 1 : -1
  return sanitizeLine(candidates[selectedIndex]?.path ?? value)
}

async function requestApprovedSources(
  ask: AskQuestion,
  discoverSources: DiscoverSources | undefined,
): Promise<string[] | null> {
  const candidates = discoverSources ? await discoverSources() : []
  if (candidates.length === 1) {
    const candidate = sanitizeLine(candidates[0].path)
    if (accepted(await ask(`Approve suggested application source ${candidate}? [y/N] `))) {
      return [candidate]
    }
  }
  const question = candidates.length > 0
    ? candidateQuestion(candidates)
    : "Application source to approve (type a path; Enter cancels): "
  const source = selectedSource(
    await ask(question, candidates.map((candidate) => candidate.path)),
    candidates,
  )
  return source ? [source] : null
}

export async function requestProviderProofApproval(
  options: SolariHandoffOptions = {},
): Promise<boolean> {
  if (!interactive(options)) return false
  const ask = options.ask ?? askInTerminal
  if (!accepted(await ask("Use Solari to prove a candidate fix? [y/N] "))) return false
  return accepted(await ask("Use AI to investigate and generate the candidate? [y/N] "))
}

export async function requestLocalDiscoveryApproval(
  options: SolariHandoffOptions = {},
): Promise<boolean> {
  if (!interactive(options)) return false
  const ask = options.ask ?? askInTerminal
  return acceptedByDefault(await ask("Search locally for a causal trigger now? [Y/n] "))
}

export async function requestProofSources(
  approvedSources: string[],
  options: SolariHandoffOptions = {},
): Promise<string[] | null> {
  if (!interactive(options)) return null
  if (approvedSources.length > 0) return approvedSources
  return requestApprovedSources(options.ask ?? askInTerminal, options.discoverSources)
}

export async function requestProofDiscoverySeconds(
  budget: DiscoveryBudget,
  options: SolariHandoffOptions = {},
): Promise<number | null> {
  if (!interactive(options)) return null
  let maxSeconds = budget.configuredSeconds
  if (budget.recommendedSeconds <= budget.configuredSeconds) return maxSeconds
  const ask = options.ask ?? askInTerminal
  const question = `Fault discovery is budgeted up to `
    + `${formatSeconds(budget.recommendedSeconds)}, above the current `
    + `${formatSeconds(budget.configuredSeconds)} limit. Raise the limit? [Y/n] `
  if (acceptedByDefault(await ask(question))) maxSeconds = budget.recommendedSeconds
  return maxSeconds
}

export async function requestSolariProof(
  approvedSources: string[],
  budget: DiscoveryBudget,
  options: SolariHandoffOptions = {},
): Promise<SolariProofRequest | null> {
  if (!await requestProviderProofApproval(options)) return null
  const sources = await requestProofSources(approvedSources, options)
  if (!sources) return null
  const maxSeconds = await requestProofDiscoverySeconds(budget, options)
  if (maxSeconds === null) return null
  return { maxSeconds, sources }
}
