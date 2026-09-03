import { createGroq } from "@ai-sdk/groq"
import type { GroqLanguageModelOptions } from "@ai-sdk/groq"
import type { LanguageModel } from "ai"
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai"

export const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b"
export const QWEN_INPUT_USD_PER_MILLION = 0.8
export const QWEN_OUTPUT_USD_PER_MILLION = 4

export function createGroqInvestigatorModel(apiKey: string, modelId: string): LanguageModel {
  if (!apiKey.trim()) {
    throw new Error("GROQ_API_KEY is required for AI investigation")
  }
  const provider = createGroq({ apiKey })
  return wrapLanguageModel({
    model: provider(modelId),
    middleware: defaultSettingsMiddleware({
      settings: {
        providerOptions: {
          groq: {
            parallelToolCalls: false,
            reasoningEffort: "low",
            reasoningFormat: "hidden",
          } satisfies GroqLanguageModelOptions,
        },
      },
    }),
  })
}
