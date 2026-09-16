import { expect, test } from "@playwright/test"

import {
  requestProofDiscoverySeconds,
  requestProofSources,
  requestProviderProofApproval,
  requestSolariProof,
} from "../../src/diagnosis/solari-handoff.js"
import { buildDiscoveryBudget } from "../../src/diagnosis/discovery-budget.js"
import { preflightProofCredentials } from "../../src/proof/preflight.js"

const interactive = { environment: {}, inputIsTTY: true, outputIsTTY: true }
const budget = { configuredSeconds: 90, estimatedSeconds: 480, recommendedSeconds: 960 }

test("discovery budget uses measured runtime and adds rounded headroom", () => {
  expect(buildDiscoveryBudget({
    concurrency: 1,
    configuredSeconds: 90,
    elapsedMilliseconds: 19_000,
    observedRuns: 4,
    plannedTrials: 96,
  })).toEqual(budget)
})

test("discovery budget retains measured headroom without a large fixed minimum", () => {
  expect(buildDiscoveryBudget({
    concurrency: 1,
    configuredSeconds: 90,
    elapsedMilliseconds: 8_800,
    observedRuns: 4,
    plannedTrials: 96,
  })).toEqual({
    configuredSeconds: 90,
    estimatedSeconds: 240,
    recommendedSeconds: 480,
  })
})

test("Solari proof handoff is skipped outside an interactive terminal", async () => {
  let questions = 0
  const ask = (): Promise<string> => {
    questions += 1
    return Promise.resolve("yes")
  }

  await expect(requestSolariProof([], budget, {
    ask,
    inputIsTTY: false,
    outputIsTTY: true,
  })).resolves.toBeNull()
  await expect(requestSolariProof([], budget, {
    ask,
    environment: { CI: "true" },
    inputIsTTY: true,
    outputIsTTY: true,
  })).resolves.toBeNull()
  expect(questions).toBe(0)
})

test("Solari proof handoff defaults to no", async () => {
  await expect(requestSolariProof(
    [],
    budget,
    { ...interactive, ask: () => Promise.resolve("") },
  )).resolves.toBeNull()
})

test("provider consent can precede local discovery without requesting sources", async () => {
  const questions: string[] = []
  const answers = ["y", "y"]
  await expect(requestProviderProofApproval({
    ask: (question) => {
      questions.push(question)
      return Promise.resolve(answers.shift() ?? "")
    },
    inputIsTTY: true,
    outputIsTTY: true,
  })).resolves.toBe(true)

  expect(questions).toHaveLength(2)
  expect(questions.join(" ")).not.toContain("source")
})

test("source approval and discovery budget can be requested after local discovery", async () => {
  await expect(requestProofSources([], {
    ask: () => Promise.resolve("1"),
    discoverSources: () => Promise.resolve([{
      path: "src/account.ts",
      reason: "imported by the selected test",
    }]),
    inputIsTTY: true,
    outputIsTTY: true,
  })).resolves.toEqual(["src/account.ts"])

  await expect(requestProofDiscoverySeconds({
    configuredSeconds: 600,
    estimatedSeconds: 720,
    recommendedSeconds: 720,
  }, {
    ask: () => Promise.resolve("n"),
    inputIsTTY: true,
    outputIsTTY: true,
  })).resolves.toBe(600)
})

test("AI candidate generation requires separate consent", async () => {
  const questions: string[] = []
  const answers = ["yes", ""]

  await expect(requestSolariProof([], budget, {
    ...interactive,
    ask: (question) => {
      questions.push(question)
      return Promise.resolve(answers.shift() ?? "")
    },
  })).resolves.toBeNull()
  expect(questions).toEqual([
    "Use Solari to prove a candidate fix? [y/N] ",
    "Use AI to investigate and generate the candidate? [y/N] ",
  ])
})

test("Solari proof handoff preserves explicitly approved sources", async () => {
  const questions: string[] = []
  const sources = ["src/checkout.ts"]

  await expect(requestSolariProof(sources, budget, {
    ...interactive,
    ask: (question) => {
      questions.push(question)
      return Promise.resolve("yes")
    },
  })).resolves.toEqual({ maxSeconds: 960, sources })
  expect(questions).toEqual([
    "Use Solari to prove a candidate fix? [y/N] ",
    "Use AI to investigate and generate the candidate? [y/N] ",
    "Fault discovery is budgeted up to 16m 0s, above the current 1m 30s limit. Raise the limit? [Y/n] ",
  ])
})

test("Solari proof handoff requires an approved source", async () => {
  const answers = ["y", "y", ""]

  await expect(requestSolariProof([], budget, {
    ...interactive,
    ask: () => Promise.resolve(answers.shift() ?? ""),
  })).resolves.toBeNull()
})

test("Solari proof handoff offers one discovered application source for approval", async () => {
  const questions: string[] = []
  const answers = ["y", "y", "y", ""]

  await expect(requestSolariProof([], budget, {
    ...interactive,
    ask: (question) => {
      questions.push(question)
      return Promise.resolve(answers.shift() ?? "")
    },
    discoverSources: () => Promise.resolve([{
      path: "src/checkout.ts",
      reason: "Imported by the selected test.",
    }]),
  })).resolves.toEqual({ maxSeconds: 960, sources: ["src/checkout.ts"] })
  expect(questions).toContain("Approve suggested application source src/checkout.ts? [y/N] ")
})

test("Solari proof handoff accepts a numbered source suggestion", async () => {
  const answers = ["y", "y", "2", "n"]
  let completions: string[] = []

  await expect(requestSolariProof([], budget, {
    ...interactive,
    ask: (question, suggestedPaths) => {
      if (question.includes("Select a number")) {
        completions = suggestedPaths ?? []
      }
      return Promise.resolve(answers.shift() ?? "")
    },
    discoverSources: () => Promise.resolve([
      { path: "src/cart.ts", reason: "Matched cart clues." },
      { path: "src/checkout.ts", reason: "Matched checkout clues." },
    ]),
  })).resolves.toEqual({ maxSeconds: 90, sources: ["src/checkout.ts"] })
  expect(completions).toEqual(["src/cart.ts", "src/checkout.ts"])
})

test("Solari proof handoff carries an approved source and raised runtime", async () => {
  const answers = ["y", "y", "src/checkout.ts", ""]

  await expect(requestSolariProof([], budget, {
    ...interactive,
    ask: () => Promise.resolve(answers.shift() ?? ""),
  })).resolves.toEqual({ maxSeconds: 960, sources: ["src/checkout.ts"] })
})

test("Solari proof handoff preserves the configured runtime when raising is declined", async () => {
  const answers = ["y", "y", "n"]

  await expect(requestSolariProof(["src/checkout.ts"], budget, {
    ...interactive,
    ask: () => Promise.resolve(answers.shift() ?? ""),
  })).resolves.toEqual({ maxSeconds: 90, sources: ["src/checkout.ts"] })
})

test("proof credentials are checked up front in provider order", async () => {
  const requested: string[] = []

  await preflightProofCredentials(true, (provider, forcePrompt) => {
    requested.push(`${provider}:${String(forcePrompt)}`)
    return Promise.resolve("configured")
  })

  expect(requested).toEqual(["groq:true", "solari:true"])
})
