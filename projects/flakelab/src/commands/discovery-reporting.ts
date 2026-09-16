export function discoveryFailureDetail(
  timedOut: boolean,
  completedTrials: number,
  plannedTrials: number | undefined,
): string {
  if (!timedOut) return `no confirmed trigger · ${completedTrials} trials`
  const progress = plannedTrials === undefined
    ? `${completedTrials} trials`
    : `${completedTrials} of ${plannedTrials} planned trials`
  return `incomplete · ${progress}`
}
