import type { EvidenceReport } from "../schema.js"

export type TrialResult = EvidenceReport["experiments"][number]["result"]
export type Hypothesis = EvidenceReport["hypotheses"][number]
export type Experiment = EvidenceReport["experiments"][number]
export type MatrixEntry = EvidenceReport["proof"]["matrix"][number]
export type Artifact = EvidenceReport["artifacts"][number]

/** Semantic tone. Every tone is also carried by a word and a border style, never colour alone. */
export type Tone = "pass" | "fail" | "open"

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 4,
    style: "currency",
  }).format(value)
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/** Renders the ISO timestamp as a stable UTC stamp so two readers never see different times. */
export function formatTimestamp(iso: string): string {
  const at = new Date(iso)
  const date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
  return `${date} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
}

export function resultTone(result: TrialResult): Tone {
  return result.failed === 0 && result.errors === 0 ? "pass" : "fail"
}

export function Tag({ label, tone }: Readonly<{
  label: string
  tone: Tone
}>): React.JSX.Element {
  return <span className={`tag tag-${tone}`}>{label}</span>
}

export function CheckTag({ label, passed }: Readonly<{
  label: string
  passed: boolean | null
}>): React.JSX.Element {
  return <span className="check" data-testid={`check-${label}`}>
    <span className="check-label">{label}</span>
    {passed === null
      ? <Tag label="NOT CONFIGURED" tone="open" />
      : <Tag label={passed ? "PASS" : "FAIL"} tone={passed ? "pass" : "fail"} />}
  </span>
}

/**
 * A failure rate as a right-aligned number plus a proportional bar. The bar is decorative;
 * the exact percentage is always present as text.
 */
export function RateCell({ rate }: Readonly<{ rate: number }>): React.JSX.Element {
  const tone: Tone = rate > 0 ? "fail" : "pass"
  return <span className="rate">
    <span className="rate-value">{percent(rate)}</span>
    <span aria-hidden="true" className="rate-track">
      <span className={`rate-fill rate-${tone}`} style={{ width: `${rate * 100}%` }} />
    </span>
  </span>
}

/** Pass/trial counts, with failures and errors spelled out rather than implied. */
export function TrialCounts({ result }: Readonly<{ result: TrialResult }>): React.JSX.Element {
  return <span className="counts">
    <span className="counts-main">{result.passed}/{result.trials}</span>
    <span className="counts-detail">
      {result.failed} failed{result.errors > 0 ? ` · ${result.errors} errors` : ""}
    </span>
  </span>
}
