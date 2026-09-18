import type { EvidenceReport } from "../schema.js"
import { CheckTag, formatMoney } from "./indicators.js"
import { Section } from "./layout.js"

function Metric({ label, value, detail }: Readonly<{
  label: string
  value: string
  detail?: string
}>): React.JSX.Element {
  return <div className="metric">
    <dt>{label}</dt>
    <dd>
      <span className="metric-value">{value}</span>
      {detail ? <span className="metric-detail">{detail}</span> : undefined}
    </dd>
  </div>
}

export function EvidenceSummarySection({ report }: Readonly<{
  report: EvidenceReport
}>): React.JSX.Element {
  const confirmed = report.hypotheses.filter((entry) => entry.status === "confirmed").length
  const tokens = report.usage.combined.inputTokens + report.usage.combined.outputTokens
  return <Section id="summary" ordinal="03" title="Evidence summary">
    <dl className="metrics">
      <Metric
        detail={`${report.hypotheses.length} hypotheses`}
        label="Experiments"
        value={String(report.experiments.length)}
      />
      <Metric detail="of the hypotheses" label="Confirmed causes" value={String(confirmed)} />
      <Metric
        label="Model cost"
        detail={`${tokens.toLocaleString("en-US")} tokens · candidate ${formatMoney(report.usage.candidateGeneration.estimatedCostUsd)}`}
        value={formatMoney(report.usage.combined.estimatedCostUsd)}
      />
      <Metric detail="proof environment" label="Execution" value={report.proof.execution} />
    </dl>
    <div className="static-checks">
      <span className="static-checks-label">Static checks</span>
      <CheckTag label="typecheck" passed={report.proof.staticChecks.typecheck} />
      <CheckTag label="eslint" passed={report.proof.staticChecks.lint} />
    </div>
  </Section>
}
