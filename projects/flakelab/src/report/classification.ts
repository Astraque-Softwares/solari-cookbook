import type { InvestigationReport } from "../investigator/schema.js"
import type { FailureOwnership } from "./schema.js"

interface Classification {
  classification: FailureOwnership
  confidence: "high" | "medium" | "low"
  rationale: string
}

const RULES: { category: FailureOwnership; terms: string[]; rationale: string }[] = [
  {
    category: "PRODUCT_RACE",
    terms: ["deadline", "race", "hydration", "ordering", "before the"],
    rationale: "A controlled timing intervention changed product behavior at an application boundary.",
  },
  {
    category: "TEST_SELECTOR",
    terms: ["locator", "selector", "detached element", "stale element"],
    rationale: "The evidence points to how the test identifies or retains an element.",
  },
  {
    category: "TEST_STATE_LEAK",
    terms: ["shared state", "state leak", "test order"],
    rationale: "The failure depends on mutable state shared across otherwise independent tests.",
  },
  {
    category: "AUTH_EXPIRATION",
    terms: ["authentication", "expired session", "access token"],
    rationale: "The observed failure is associated with authentication lifetime or session state.",
  },
  {
    category: "BACKEND_NONDETERMINISM",
    terms: ["non-2xx", "backend", "server response", "status code"],
    rationale: "The evidence attributes varying behavior to backend responses or server state.",
  },
  {
    category: "EXTERNAL_DEPENDENCY",
    terms: ["third-party", "external dependency", "upstream"],
    rationale: "The causal intervention isolates a service outside the application boundary.",
  },
  {
    category: "INFRASTRUCTURE_PRESSURE",
    terms: ["cpu", "memory pressure", "ci load", "worker pressure"],
    rationale: "The failure correlates with constrained execution resources or worker pressure.",
  },
]

export function classifyFailure(investigation: InvestigationReport): Classification {
  const confirmed = investigation.hypotheses.find((hypothesis) =>
    hypothesis.id === investigation.conclusionHypothesisId && hypothesis.status === "confirmed")
  const evidence = `${investigation.conclusion} ${confirmed?.explanation ?? ""}`.toLowerCase()
  const rule = RULES.find((candidate) =>
    candidate.terms.some((term) => evidence.includes(term)))
  if (!rule) {
    return {
      classification: "UNKNOWN",
      confidence: "low",
      rationale: "The current evidence does not map cleanly to a supported ownership category.",
    }
  }
  return {
    classification: rule.category,
    confidence: confirmed ? "high" : "medium",
    rationale: rule.rationale,
  }
}
