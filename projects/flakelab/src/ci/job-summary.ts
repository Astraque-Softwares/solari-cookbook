import type { InvestigationReport } from "../investigator/schema.js"
import type { ProofOfFix } from "../repair/schema.js"
import type { Reproducer } from "../reproducer/schema.js"

interface JobSummaryInput {
  artifactUrl?: string
  investigation: InvestigationReport
  proof: ProofOfFix
  reproducer: Reproducer
}

function safeText(value: string): string {
  let withoutControls = ""
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    withoutControls += code < 32 || code === 127 ? " " : character
  }
  return withoutControls
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .trim()
}

function ratio(passed: number, trials: number): string {
  return `${passed}/${trials} passed`
}

export function buildJobSummary(input: JobSummaryInput): string {
  const fault = input.reproducer.faults[0]
  const result = input.proof.patchAccepted ? "Candidate fix proved" : "Candidate fix rejected"
  const reportLink = input.artifactUrl?.startsWith("https://github.com/")
    ? `[Download the portable evidence report](${input.artifactUrl})`
    : "Portable evidence report attached to this workflow run."
  return `# FlakeLab

## ${result}

**Test:** \`${safeText(input.reproducer.test)}\`  
**Confirmed hypothesis:** \`${safeText(input.investigation.conclusionHypothesisId)}\`  
**Minimal trigger:** ${fault.delayMs} ms delay matching \`${safeText(fault.pattern)}\`

${safeText(input.investigation.conclusion)}

| Proof condition | Result | Failure rate |
| --- | ---: | ---: |
| Hostile before patch | ${ratio(input.proof.beforeHostile.passed, input.proof.beforeHostile.trials)} | ${(input.proof.beforeHostile.failureRate * 100).toFixed(0)}% |
| Hostile after patch | ${ratio(input.proof.afterHostile.passed, input.proof.afterHostile.trials)} | ${(input.proof.afterHostile.failureRate * 100).toFixed(0)}% |
| Normal after patch | ${ratio(input.proof.afterControl.passed, input.proof.afterControl.trials)} | ${(input.proof.afterControl.failureRate * 100).toFixed(0)}% |

Static checks: typecheck ${input.proof.staticChecks.typecheck ? "passed" : "failed"}; lint ${input.proof.staticChecks.lint ? "passed" : "failed"}.  
Model: \`${safeText(input.investigation.model)}\`; estimated model cost: $${input.investigation.usage.estimatedCostUsd.toFixed(4)}.

${reportLink}
`
}
