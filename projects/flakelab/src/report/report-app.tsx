import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { EvidenceReport } from "./schema.js"

interface ReportAppProps {
  readonly report: EvidenceReport
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 4,
    style: "currency",
  }).format(value)
}

function CheckIcon({ passed }: Readonly<{ passed: boolean }>): React.JSX.Element {
  return <span aria-hidden="true" className={passed ? "check pass" : "check fail"}>
    {passed ? "✓" : "×"}
  </span>
}

function Metric({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return <div className="metric">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
}

function StatusPill({ status }: Readonly<{
  status: EvidenceReport["status"]
}>): React.JSX.Element {
  const accepted = status === "FIX_PROVEN"
  return <div className={accepted ? "status-pill accepted" : "status-pill rejected"}>
    <span className="pulse" aria-hidden="true" />
    {accepted ? "Fix independently proven" : "Candidate rejected"}
  </div>
}

function chartLabel(label: string): string {
  if (label === "Before · hostile") {
    return "Before"
  }
  if (label === "After · hostile") {
    return "Hostile fixed"
  }
  if (label === "After · clean") {
    return "Clean"
  }
  return "Regression"
}

function ProofChart({ report }: ReportAppProps): React.JSX.Element {
  const data = report.proof.matrix.map((entry) => ({
    label: chartLabel(entry.label),
    failureRate: Math.round(entry.result.failureRate * 100),
  }))
  return <div className="chart" aria-label="Before and after failure-rate chart">
    <ResponsiveContainer width="100%" height={270}>
      <BarChart data={data} margin={{ top: 12, right: 8, left: -22, bottom: 24 }}>
        <CartesianGrid stroke="rgba(255,255,255,.07)" vertical={false} />
        <XAxis dataKey="label" stroke="#7f8da3" tickLine={false} axisLine={false} />
        <YAxis domain={[0, 100]} stroke="#7f8da3" tickLine={false} axisLine={false} unit="%" />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,.035)" }}
          contentStyle={{ background: "#101823", border: "1px solid #29384a", borderRadius: 10 }}
          formatter={(value) => [`${String(value)}%`, "Failure rate"]}
        />
        <Bar dataKey="failureRate" fill="#ff746c" radius={[7, 7, 2, 2]} />
      </BarChart>
    </ResponsiveContainer>
  </div>
}

function ProofMatrix({ report }: ReportAppProps): React.JSX.Element {
  return <div className="proof-matrix">
    {report.proof.matrix.map((entry) => {
      const passed = entry.result.failed === 0 && entry.result.errors === 0
      return <div className="proof-row" key={entry.label}>
        <CheckIcon passed={passed} />
        <div>
          <strong>{entry.label}</strong>
          <span>{entry.result.passed}/{entry.result.trials} passed · {percent(entry.result.failureRate)} failure</span>
        </div>
      </div>
    })}
  </div>
}

function ExperimentTimeline({ report }: ReportAppProps): React.JSX.Element {
  return <div className="timeline">
    {report.experiments.map((experiment, index) => <article className="timeline-item" key={experiment.id}>
      <div className="timeline-marker">{index + 1}</div>
      <div className="timeline-card">
        <div className="eyebrow">{experiment.id} · tests {experiment.hypothesisId}</div>
        <h3>{experiment.condition}</h3>
        <div className="result-line">
          <strong>{experiment.result.passed}/{experiment.result.trials} passed</strong>
          <span>{percent(experiment.result.failureRate)} failure rate</span>
          <span>{percent(experiment.result.lowerBound80)} confidence floor</span>
        </div>
      </div>
    </article>)}
  </div>
}

function HypothesisLedger({ report }: ReportAppProps): React.JSX.Element {
  return <div className="ledger">
    {report.hypotheses.map((hypothesis) => <article className="hypothesis" key={hypothesis.id}>
      <div className="hypothesis-heading">
        <span className="hypothesis-id">{hypothesis.id}</span>
        <span className={`hypothesis-status ${hypothesis.status}`}>{hypothesis.status}</span>
      </div>
      <h3>{hypothesis.statement}</h3>
      <p>{hypothesis.explanation}</p>
      <small>Evidence · {hypothesis.evidenceExperimentIds.join(", ")}</small>
    </article>)}
  </div>
}

export function ReportApp({ report }: ReportAppProps): React.JSX.Element {
  const confirmed = report.hypotheses.filter((entry) => entry.status === "confirmed").length
  return <main>
    <header className="topbar">
      <a className="brand" href="#top" aria-label="FlakeLab report home">
        <span className="brand-mark" aria-hidden="true">F</span>
        <span>FlakeLab</span>
      </a>
      <div className="report-meta">
        <span>Evidence report</span>
        <span>{new Date(report.generatedAt).toLocaleString()}</span>
      </div>
    </header>

    <section className="hero" id="top">
      <div className="hero-copy">
        <StatusPill status={report.status} />
        <p className="eyebrow">Causal debugging · {report.model}</p>
        <h1>We found what makes<br /><em>this test fail.</em></h1>
        <p className="test-path">{report.test}</p>
      </div>
      <div className="trigger-card">
        <div className="trigger-orbit" aria-hidden="true"><span>{report.trigger.delayMs}</span><small>ms</small></div>
        <div>
          <span className="eyebrow">Minimal hostile trigger</span>
          <strong>{report.trigger.pattern}</strong>
          <p>Delay exceeds the application deadline and reproduces the observed failure.</p>
        </div>
      </div>
    </section>

    <section className="metrics" aria-label="Investigation summary">
      <Metric label="Experiments" value={String(report.experiments.length)} />
      <Metric label="Confirmed causes" value={String(confirmed)} />
      <Metric label="Proof environment" value="Solari VM" />
      <Metric label="Model cost" value={formatMoney(report.usage.estimatedCostUsd)} />
    </section>

    <section className="panel root-cause">
      <div>
        <p className="eyebrow">Root cause</p>
        <h2>{report.ownership.classification.replaceAll("_", " ")}</h2>
        <p className="conclusion">{report.conclusion}</p>
      </div>
      <div className="confidence-card">
        <span>Ownership confidence</span>
        <strong>{report.ownership.confidence}</strong>
        <p>{report.ownership.rationale}</p>
      </div>
    </section>

    <section className="section-block">
      <div className="section-heading">
        <div><p className="eyebrow">Experimental record</p><h2>Hypotheses, tested—not guessed</h2></div>
        <p>{report.experiments.length} controlled interventions</p>
      </div>
      <ExperimentTimeline report={report} />
    </section>

    <section className="section-block">
      <div className="section-heading">
        <div><p className="eyebrow">Reasoning ledger</p><h2>Competing explanations</h2></div>
      </div>
      <HypothesisLedger report={report} />
    </section>

    <section className="panel proof-section">
      <div className="section-heading">
        <div><p className="eyebrow">Proof of fix</p><h2>Failure eliminated. Controls preserved.</h2></div>
        <div className="static-checks">
          <span><CheckIcon passed={report.proof.staticChecks.typecheck} /> Typecheck</span>
          <span><CheckIcon passed={report.proof.staticChecks.lint} /> ESLint</span>
        </div>
      </div>
      <div className="proof-grid">
        <ProofChart report={report} />
        <ProofMatrix report={report} />
      </div>
    </section>

    <section className="artifacts section-block">
      <div className="section-heading">
        <div><p className="eyebrow">Reproducible evidence</p><h2>Inspect every artifact</h2></div>
      </div>
      <div className="artifact-grid">
        {report.artifacts.map((artifact) => <a className="artifact" href={artifact.path} key={artifact.label}>
          <span>{artifact.label}</span><code>{artifact.path}</code>
        </a>)}
      </div>
    </section>

    <footer>
      <span>Generated locally by FlakeLab</span>
      <span>No runtime network access · CSP locked · evidence embedded</span>
    </footer>
  </main>
}
