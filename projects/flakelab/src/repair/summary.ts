import type { DocumentRow } from "../ui/document.js"
import { TerminalDocument } from "../ui/document.js"
import { formatCount } from "../ui/format.js"
import type { StatusTone } from "../ui/status.js"
import type { TerminalTheme } from "../ui/theme.js"
import { PLAIN_THEME } from "../ui/theme.js"
import type { ProofOfFix } from "./schema.js"

type ValidationResult = ProofOfFix["beforeHostile"]

function trialSummary(result: ValidationResult): string {
  const outcome = `${result.passed}/${result.trials} passed · ${result.failed} failed`
  return result.errors > 0 ? `${outcome} · ${formatCount(result.errors, "error")}` : outcome
}

function regressionSummary(proof: ProofOfFix): string {
  const failures = proof.regressions.reduce((total, entry) => total + entry.result.failed, 0)
  return `${formatCount(proof.regressions.length, "nearby selector")}`
    + ` · ${formatCount(failures, "failure")}`
}

export function checkLabel(passed: boolean | null): string {
  if (passed === null) return "not configured"
  return passed ? "passed" : "failed"
}

function proofRows(proof: ProofOfFix): DocumentRow[] {
  return [
    { label: "Before hostile", value: trialSummary(proof.beforeHostile) },
    { label: "After hostile", value: trialSummary(proof.afterHostile) },
    { label: "Clean control", value: trialSummary(proof.afterControl) },
    { label: "Regressions", value: regressionSummary(proof) },
    { label: "Typecheck", value: checkLabel(proof.staticChecks.typecheck) },
    { label: "Lint", value: checkLabel(proof.staticChecks.lint) },
    ...(proof.resources ? [{
      label: "Solari resources",
      value: `${proof.resources.created} created · ${proof.resources.released} released · ${proof.resources.live} live`,
    }] : []),
  ]
}

function appendDiagnostics(document: TerminalDocument, proof: ProofOfFix): void {
  const diagnostics: [string, string | undefined][] = [
    ["Typecheck", proof.staticDiagnostics.typecheck],
    ["ESLint", proof.staticDiagnostics.lint],
  ]
  const reported = diagnostics.filter(([, value]) => value !== undefined && value !== "")
  if (reported.length === 0) {
    return
  }
  document.section("Static diagnostics")
  for (const [label, value] of reported) {
    document.entry("warning", label, value ?? "")
  }
}

/**
 * The proof matrix as one scannable block: the hostile condition before and
 * after the patch, the clean control, nearby regressions, and static checks.
 */
export function formatProofSummary(
  proof: ProofOfFix,
  paths: { patch: string; proof: string },
  theme: TerminalTheme = PLAIN_THEME,
): string {
  const tone: StatusTone = proof.patchAccepted ? "success" : "failure"
  const document = new TerminalDocument(theme)
  document.entry(
    tone,
    proof.patchAccepted ? "candidate accepted" : "candidate rejected",
    proof.patchAccepted
      ? "The patch removed the hostile failure without breaking clean behavior."
      : "The patch did not satisfy every proof condition; the evidence is retained.",
  )
  document.blank().section("Proof matrix").rows(proofRows(proof))
  appendDiagnostics(document, proof)
  document.section("Evidence").rows([
    { label: "Patch", value: paths.patch },
    { label: "Proof", value: paths.proof },
  ])
  return document.render()
}
