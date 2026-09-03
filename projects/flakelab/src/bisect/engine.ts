import type { BisectReport, Revision, RevisionEvidence } from "./schema.js"
import { bisectReportSchema } from "./schema.js"

export type RevisionEvaluator = (revision: Revision) => Promise<RevisionEvidence>

interface BisectOptions {
  evaluate: RevisionEvaluator
  minimumFailureRate: number
  parallelism?: number
  revisions: Revision[]
}

function selectCandidates(
  lower: number,
  upper: number,
  evaluated: ReadonlyMap<number, RevisionEvidence>,
  parallelism: number,
): number[] {
  const available = Array.from(
    { length: Math.max(0, upper - lower - 1) },
    (_, offset) => lower + offset + 1,
  ).filter((index) => !evaluated.has(index))
  if (available.length <= parallelism) {
    return available
  }
  return Array.from({ length: parallelism }, (_, slot) => {
    const position = Math.floor(((slot + 1) * available.length) / (parallelism + 1))
    return available[Math.min(position, available.length - 1)]
  }).filter((value, index, values) => values.indexOf(value) === index)
}

function assertMonotonic(evaluated: ReadonlyMap<number, RevisionEvidence>): void {
  const goodIndexes = [...evaluated.entries()]
    .filter((entry) => entry[1].classification === "good")
    .map((entry) => entry[0])
  const badIndexes = [...evaluated.entries()]
    .filter((entry) => entry[1].classification === "bad")
    .map((entry) => entry[0])
  if (goodIndexes.length > 0 && badIndexes.length > 0
    && Math.max(...goodIndexes) >= Math.min(...badIndexes)) {
    throw new Error("revision evidence is non-monotonic; a good revision follows a bad revision")
  }
}

function boundaries(evaluated: ReadonlyMap<number, RevisionEvidence>): [number, number] {
  const good = [...evaluated.entries()]
    .filter((entry) => entry[1].classification === "good")
    .map((entry) => entry[0])
  const bad = [...evaluated.entries()]
    .filter((entry) => entry[1].classification === "bad")
    .map((entry) => entry[0])
  return [Math.max(...good), Math.min(...bad)]
}

async function evaluateIndexes(
  indexes: number[],
  revisions: Revision[],
  evaluate: RevisionEvaluator,
  evaluated: Map<number, RevisionEvidence>,
): Promise<void> {
  const results = await Promise.all(indexes.map(async (index) => {
    try {
      return {
        status: "fulfilled" as const,
        index,
        evidence: await evaluate(revisions[index]),
      }
    } catch (error) {
      return {
        status: "rejected" as const,
        error: error instanceof Error ? error : new Error("revision evaluation failed"),
      }
    }
  }))
  const failure = results.find((result) => result.status === "rejected")
  if (failure?.status === "rejected") {
    throw failure.error
  }
  for (const result of results) {
    if (result.status === "fulfilled") {
      evaluated.set(result.index, result.evidence)
    }
  }
}

function validateOptions(options: BisectOptions): number {
  if (options.revisions.length < 2) {
    throw new Error("bisect requires at least two revisions")
  }
  if (options.minimumFailureRate <= 0 || options.minimumFailureRate > 1) {
    throw new Error("minimum failure rate must be greater than 0 and at most 1")
  }
  const parallelism = options.parallelism ?? 2
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 4) {
    throw new Error("bisect parallelism must be an integer between 1 and 4")
  }
  return parallelism
}

export async function statisticalBisect(options: BisectOptions): Promise<BisectReport> {
  const parallelism = validateOptions(options)
  const evaluated = new Map<number, RevisionEvidence>()
  const lastIndex = options.revisions.length - 1
  await evaluateIndexes([0, lastIndex], options.revisions, options.evaluate, evaluated)
  if (evaluated.get(0)?.classification !== "good") {
    throw new Error("the selected good revision was not classified as good")
  }
  if (evaluated.get(lastIndex)?.classification !== "bad") {
    throw new Error("the selected bad revision was not classified as bad")
  }
  let [goodIndex, badIndex] = boundaries(evaluated)
  while (badIndex - goodIndex > 1) {
    const candidates = selectCandidates(goodIndex, badIndex, evaluated, parallelism)
    if (candidates.length === 0) {
      break
    }
    await evaluateIndexes(candidates, options.revisions, options.evaluate, evaluated)
    assertMonotonic(evaluated)
    ;[goodIndex, badIndex] = boundaries(evaluated)
  }
  const exact = badIndex - goodIndex === 1
  const evidence = [...evaluated.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1])
  return bisectReportSchema.parse({
    version: 1,
    goodRevision: options.revisions[0],
    badRevision: options.revisions[lastIndex],
    firstFailingCommit: exact ? options.revisions[badIndex] : null,
    earliestKnownBadCommit: options.revisions[badIndex],
    exact,
    minimumFailureRate: options.minimumFailureRate,
    evaluatedRevisionCount: evaluated.size,
    totalRevisionCount: options.revisions.length,
    evidence,
  })
}
