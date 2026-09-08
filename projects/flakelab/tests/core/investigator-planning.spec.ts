import { expect, test } from "@playwright/test"

import {
  generateValidInvestigationPlan,
  investigationPlanSchema,
} from "../../src/investigator/planning.js"
import { RecoverableGenerationError } from "../../src/investigator/generation.js"

const hypotheses = [
  {
    prediction: "Network delay will reproduce the checkout timeout",
    statement: "Checkout has a response timing race",
  },
  {
    prediction: "A failed request will expose missing error handling",
    statement: "Checkout mishandles failed requests",
  },
]

const duplicatePlan = investigationPlanSchema.parse({
  experiments: [
    { condition: { kind: "baseline" }, hypothesisIndex: 0 },
    { condition: { delayMs: 60, kind: "network-delay" }, hypothesisIndex: 0 },
    { condition: { delayMs: 120, kind: "network-delay" }, hypothesisIndex: 1 },
  ],
  hypotheses,
})

const correctedPlan = investigationPlanSchema.parse({
  experiments: [
    { condition: { kind: "baseline" }, hypothesisIndex: 0 },
    { condition: { delayMs: 60, kind: "network-delay" }, hypothesisIndex: 0 },
    { condition: { kind: "request-failure", statusCode: 503 }, hypothesisIndex: 1 },
  ],
  hypotheses,
})

test("an invalid model plan receives one deterministic repair attempt", async () => {
  const prompts: string[] = []
  const temperatures: number[] = []
  const plans = [duplicatePlan, correctedPlan]

  const result = await generateValidInvestigationPlan({
    generate: (prompt, temperature) => {
      prompts.push(prompt)
      temperatures.push(temperature)
      return Promise.resolve({
        output: plans[prompts.length - 1] ?? correctedPlan,
        usage: { inputTokens: 10, outputTokens: 5 },
      })
    },
    initialPrompt: "Plan a bounded causal investigation.",
    maxAttempts: 2,
    rules: { maxExperiments: 3, maximumDelayMs: 500 },
  })

  expect(result.plan).toEqual(correctedPlan)
  expect(result.generations).toHaveLength(2)
  expect(temperatures).toEqual([0.2, 0])
  expect(prompts[1]).toContain("received baseline, network-delay, network-delay")
  expect(prompts[1]).toContain("do not repeat a condition kind")
})

test("plan repair remains bounded by its attempt budget", async () => {
  await expect(generateValidInvestigationPlan({
    generate: () => Promise.resolve({
      output: duplicatePlan,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    initialPrompt: "Plan a bounded causal investigation.",
    maxAttempts: 1,
    rules: { maxExperiments: 3, maximumDelayMs: 500 },
  })).rejects.toThrow(/received baseline, network-delay, network-delay/u)
})

test("schema-invalid plan JSON receives one bounded correction attempt", async () => {
  const prompts: string[] = []

  const result = await generateValidInvestigationPlan({
    generate: (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) {
        return Promise.reject(new RecoverableGenerationError(
          "missing property: experiments",
          '{"hypotheses":[]}',
          { inputTokens: 8, outputTokens: 3 },
        ))
      }
      return Promise.resolve({
        output: correctedPlan,
        usage: { inputTokens: 10, outputTokens: 5 },
      })
    },
    initialPrompt: "Plan a bounded causal investigation.",
    maxAttempts: 2,
    rules: { maxExperiments: 3, maximumDelayMs: 500 },
  })

  expect(result.plan).toEqual(correctedPlan)
  expect(result.attempts).toEqual([
    { inputTokens: 8, outputTokens: 3 },
    { inputTokens: 10, outputTokens: 5 },
  ])
  expect(prompts[1]).toContain("missing property: experiments")
  expect(prompts[1]).toContain('{"hypotheses":[]}')
})

test("a plan must test both hypotheses with interventions", async () => {
  const baselineOnlyPlan = investigationPlanSchema.parse({
    experiments: [
      { condition: { kind: "baseline" }, hypothesisIndex: 0 },
      { condition: { delayMs: 60, kind: "network-delay" }, hypothesisIndex: 1 },
      { condition: { kind: "request-failure", statusCode: 503 }, hypothesisIndex: 1 },
    ],
    hypotheses,
  })

  await expect(generateValidInvestigationPlan({
    generate: () => Promise.resolve({
      output: baselineOnlyPlan,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    initialPrompt: "Plan a bounded causal investigation.",
    maxAttempts: 1,
    rules: { maxExperiments: 3, maximumDelayMs: 500 },
  })).rejects.toThrow(/non-baseline intervention/u)
})

test("a pipeline plan must repeat the intervention confirmed by discovery", async () => {
  await expect(generateValidInvestigationPlan({
    generate: () => Promise.resolve({
      output: correctedPlan,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    initialPrompt: "Plan a bounded causal investigation.",
    maxAttempts: 1,
    rules: {
      maxExperiments: 3,
      maximumDelayMs: 500,
      requiredCondition: { kind: "reduced-motion" },
    },
  })).rejects.toThrow(/must include the discovered reduced-motion intervention/u)
})

test("a pipeline plan must preserve the exact discovered trigger", async () => {
  await expect(generateValidInvestigationPlan({
    generate: () => Promise.resolve({
      output: correctedPlan,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    initialPrompt: "Plan a bounded causal investigation.",
    maxAttempts: 1,
    rules: {
      maxExperiments: 3,
      maximumDelayMs: 500,
      requiredCondition: { delayMs: 125, kind: "network-delay" },
    },
  })).rejects.toThrow(/must include the discovered network-delay intervention exactly/u)
})
