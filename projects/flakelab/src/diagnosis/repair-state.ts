import type { RepairResult } from "../commands/repair.js"
import type { ProofResources } from "../repair/solari-validator.js"
import type { DiagnosisContext } from "./run-state.js"
import { addDiagnosisUsage } from "./run-state.js"

export function recordRepairUsage(
  context: DiagnosisContext,
  result: RepairResult,
  elapsedMilliseconds: number,
): void {
  if (result.outcome === "candidate-invalid") {
    addDiagnosisUsage(context, {
      elapsedMilliseconds,
      executions: 0,
      solariSandboxesCreated: 0,
      solariSandboxesKilled: 0,
      solariCostUsd: 0,
    })
    return
  }
  addDiagnosisUsage(context, {
    elapsedMilliseconds,
    executions: result.proof.beforeHostile.trials
      + result.proof.afterHostile.trials
      + result.proof.afterControl.trials
      + result.proof.regressions.reduce(
        (total, regression) => total + regression.result.trials,
        0,
      ),
    solariSandboxesCreated: result.proof.resources?.created ?? 0,
    solariSandboxesKilled: result.proof.resources?.released ?? 0,
    solariCostUsd: null,
  })
}

export function recordProofCleanup(
  context: DiagnosisContext,
  resources?: ProofResources,
): void {
  context.checkpoint.cleanup = {
    liveResources: resources?.live ?? 0,
    status: resources ? "confirmed" : "unconfirmed",
  }
}
