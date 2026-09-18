import type {
  AutomaticFaultScreening,
  AutomaticScreeningCapabilities,
} from "../discovery/automatic.js"

export interface DiscoveryContextEvidence {
  automaticScreening?: AutomaticFaultScreening[]
  relevance: {
    nativeSignatureMatch: "unknown"
    note: string
  }
}

export function addDiscoveryContext<T>(
  result: T,
  screenings: AutomaticFaultScreening[] | undefined,
  capabilities: AutomaticScreeningCapabilities,
): T & DiscoveryContextEvidence {
  const note = capabilities.scan?.clean
    ? "No natural failure was observed in the clean scan. The trigger is causally sufficient under injection, but is not claimed as the cause of an observed CI failure."
    : "No compatible natural failure signature was available for comparison. The trigger is causally sufficient under injection; relevance to an external flake remains unknown."
  return {
    ...result,
    ...(screenings ? { automaticScreening: screenings } : {}),
    relevance: { nativeSignatureMatch: "unknown", note },
  }
}
