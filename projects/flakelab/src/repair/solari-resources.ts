import type { Sandbox, SandboxClient } from "@solarisdk/sandbox"

import { retryTransient } from "../solari/retry.js"

export interface ProofResources {
  created: number
  live: number
  released: number
}

export class SolariProofError extends Error {
  readonly resources: ProofResources

  constructor(message: string, resources: ProofResources, cause?: Error) {
    super(message, { cause })
    this.name = "SolariProofError"
    this.resources = resources
  }
}

export async function cleanupProofSandbox(
  client: SandboxClient,
  sandbox: Sandbox,
  runMarker: string,
  resources: ProofResources,
): Promise<Error | undefined> {
  let failure: Error | undefined
  try {
    sandbox.close()
  } catch (cause) {
    failure = new Error("Solari sandbox connection cleanup failed", {
      cause: cause instanceof Error ? cause : undefined,
    })
  }
  try {
    await retryTransient(async () => client.kill(sandbox.sandboxId), {
      attempts: 3,
      baseDelayMs: 500,
    })
    resources.released = 1
  } catch (cause) {
    failure = new Error("Solari sandbox cleanup failed", {
      cause: cause instanceof Error ? cause : undefined,
    })
  }
  try {
    for await (const sandboxView of client.listAll({
      metadata: { product: "flakelab", role: "patch-proof", run: runMarker },
      state: "running",
    })) {
      if (sandboxView.sandboxId) resources.live += 1
    }
  } catch (cause) {
    failure = new Error("Solari resource cleanup could not be confirmed", {
      cause: cause instanceof Error ? cause : undefined,
    })
  }
  return failure
}

export function completedProof<Result>(
  result: Result | undefined,
  resources: ProofResources,
  failure?: Error,
): Result & { resources: ProofResources } {
  if (failure) throw new SolariProofError(failure.message, resources, failure)
  if (!result) throw new SolariProofError("Solari proof returned no result", resources)
  if (resources.live > 0) throw new SolariProofError("Solari proof left a live sandbox", resources)
  return { ...result, resources }
}
