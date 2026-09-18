import type { EvidenceReport } from "../schema.js"
import { Tag } from "./indicators.js"
import { Section, SpecList } from "./layout.js"

const VERDICT_COPY = {
  CANDIDATE_INVALID: {
    headline: "CANDIDATE INVALID",
    summary: "No candidate passed bounded local policy and validation; isolated proof did not begin.",
  },
  FIX_PROVEN: {
    headline: "FIX PROVEN",
    summary: "The candidate patch was accepted by an independent proof run.",
  },
  PATCH_REJECTED: {
    headline: "PATCH REJECTED",
    summary: "The candidate patch was not accepted by the proof run.",
  },
} as const

export function VerdictSection({ report }: Readonly<{
  report: EvidenceReport
}>): React.JSX.Element {
  const proven = report.status === "FIX_PROVEN"
  const copy = VERDICT_COPY[report.status]
  return <Section id="verdict" ordinal="01" title="Verdict">
    <div className={proven ? "verdict verdict-pass" : "verdict verdict-fail"}>
      <p className="verdict-headline">
        {copy.headline}
        <Tag label={proven ? "PASS" : "FAIL"} tone={proven ? "pass" : "fail"} />
      </p>
      <p className="verdict-summary">{copy.summary}</p>
    </div>

    <SpecList entries={[
      { label: "Test", mono: true, value: report.test },
      { label: "Ownership", mono: true, value: report.ownership.classification },
      {
        label: "Confidence",
        mono: true,
        value: report.ownership.confidence.toUpperCase(),
      },
    ]} />

    <div className="prose">
      <h3 className="sub-title">Root cause</h3>
      <p>{report.conclusion}</p>
      <p className="evidence-refs">
        <span className="evidence-label">Intervention evidence</span>
        {report.causalClaim.interventionExperimentIds.map((id) =>
          <a className="ref" href={`#exp-${encodeURIComponent(id)}`} key={id}>{id}</a>)}
        <span className="evidence-label">Clean control</span>
        {report.causalClaim.controlExperimentIds.map((id) =>
          <a className="ref" href={`#exp-${encodeURIComponent(id)}`} key={id}>{id}</a>)}
      </p>
      <p className="note">
        <span className="note-label">Classification basis</span>
        {report.ownership.rationale}
      </p>
    </div>
  </Section>
}
