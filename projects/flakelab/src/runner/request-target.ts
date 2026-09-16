import type { RepositoryProfile } from "../project/schema.js"
import { repositoryEnvironment } from "../project/profile.js"
import { createPlaywrightExecutor } from "./playwright-executor.js"
import type { ObservedRequest } from "./request-observation.js"

export const AUTOMATIC_REQUEST_PATTERN = "auto"

export interface RequestPatternCandidate {
  pattern: string
  reason: string
  score: number
  url: string
}

const STATIC_EXTENSION = /\.(?:css|gif|ico|jpe?g|map|png|svg|woff2?|ttf)$/iu
const DATA_PATH = /(?:^|\/)(?:api|data|graphql|kcab|rpc)(?:\/|$)/iu
const DEVELOPMENT_PATH = /(?:^|\/)(?:@fs|@id|@vite|node_modules|src)(?:\/|$)/iu
const GENERATED_SEGMENT = /^(?:\d{4,}|[a-f\d]{16,}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu

function portablePathPattern(pathname: string): string {
  if (pathname === "/") return "**/*"
  const generalized = pathname.split("/").map((segment) =>
    GENERATED_SEGMENT.test(segment) || segment.length > 48 ? "*" : segment).join("/")
  return generalized.endsWith("/*") ? `**${generalized}` : `**${generalized}*`
}

function requestScore(request: ObservedRequest, pathname: string): number {
  let score = Math.min(request.count, 20)
  if (request.resourceType === "other") score += 50
  if (request.resourceType === "document") score -= 10
  if (request.method !== "GET" && request.method !== "HEAD") score += 25
  if (DATA_PATH.test(pathname)) score += 80
  if (/worker/iu.test(pathname)) score += 35
  if (STATIC_EXTENSION.test(pathname)) score -= 30
  if (DEVELOPMENT_PATH.test(pathname)) score -= 60
  return score
}

function candidateReason(request: ObservedRequest, pathname: string): string {
  const reasons = [`observed ${request.count} time(s)`, request.resourceType]
  if (DATA_PATH.test(pathname)) reasons.push("application data route")
  if (request.method !== "GET" && request.method !== "HEAD") reasons.push(request.method)
  if (/worker/iu.test(pathname)) reasons.push("application worker")
  return reasons.join(" · ")
}

export function rankObservedRequestPatterns(
  requests: readonly ObservedRequest[],
): RequestPatternCandidate[] {
  return requests.map((request) => {
    const target = new URL(request.url)
    return {
      pattern: portablePathPattern(target.pathname),
      reason: candidateReason(request, target.pathname),
      score: requestScore(request, target.pathname),
      url: request.url,
    }
  }).sort((left, right) => right.score - left.score
    || left.pattern.localeCompare(right.pattern)
    || left.url.localeCompare(right.url))
}

export async function resolveRequestPattern(options: {
  pattern: string
  repository: RepositoryProfile
  seed: number
  selector: string
  signal?: AbortSignal
}): Promise<{ candidates: RequestPatternCandidate[]; pattern: string }> {
  if (options.pattern !== AUTOMATIC_REQUEST_PATTERN) {
    return { candidates: [], pattern: options.pattern }
  }
  const observed: ObservedRequest[] = []
  const execute = createPlaywrightExecutor(options.repository.executionRoot, options.selector, {
    artifactRoot: options.repository.artifactRoot,
    configPath: options.repository.playwright.configPath,
    environment: repositoryEnvironment(options.repository),
    onObservedRequests: (requests) => observed.push(...requests),
    playwrightCliPath: options.repository.playwright.cliPath,
    signal: options.signal,
  })
  await execute({
    faults: [],
    index: 0,
    seed: options.seed,
    trialId: `request-calibration-${options.seed}`,
  })
  const candidates = rankObservedRequestPatterns(observed)
  const selected = candidates[0]
  if (!selected) {
    throw new Error(
      "FlakeLab could not observe an HTTP request for automatic fault targeting; pass --pattern <glob>",
    )
  }
  return { candidates, pattern: selected.pattern }
}
