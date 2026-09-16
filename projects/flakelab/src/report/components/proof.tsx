import type { EvidenceReport } from "../schema.js"
import type { MatrixEntry } from "./indicators.js"
import { CheckTag, percent, RateCell, resultTone, Tag, TrialCounts } from "./indicators.js"
import { Section, TableScroll } from "./layout.js"

const BEFORE_HOSTILE = "Before · hostile"
const AFTER_HOSTILE = "After · hostile"

function find(matrix: readonly MatrixEntry[], label: string): MatrixEntry | undefined {
  return matrix.find((entry) => entry.label === label)
}

function DeltaRow({ entry, term }: Readonly<{
  entry: MatrixEntry
  term: string
}>): React.JSX.Element {
  return <div className="delta-row">
    <dt>{term}</dt>
    <dd>
      <RateCell rate={entry.result.failureRate} />
      <span className="delta-counts">{entry.result.passed}/{entry.result.trials} passed</span>
    </dd>
  </div>
}

/**
 * The headline comparison: the same hostile trigger, before and after the patch. Two aligned
 * bars sharing one scale, so the change is legible before any table is read.
 */
function HostileDelta({ matrix }: Readonly<{
  matrix: readonly MatrixEntry[]
}>): React.JSX.Element | undefined {
  const before = find(matrix, BEFORE_HOSTILE)
  const after = find(matrix, AFTER_HOSTILE)
  if (!before || !after) {
    return undefined
  }
  return <figure aria-labelledby="delta-caption" className="delta">
    <figcaption id="delta-caption">
      Failure rate under the hostile trigger, before and after the candidate patch
    </figcaption>
    <dl className="delta-bars">
      <DeltaRow entry={before} term="Before" />
      <DeltaRow entry={after} term="After" />
    </dl>
  </figure>
}

function MatrixTable({ matrix }: Readonly<{
  matrix: readonly MatrixEntry[]
}>): React.JSX.Element {
  return <><p className="table-note">
    Every condition re-executed against the patched workspace, including the clean control
    and regression checks.
  </p>
  <TableScroll label="Proof matrix">
    <table className="grid">
      <caption className="sr-only">Proof matrix</caption>
      <thead>
        <tr>
          <th scope="col">Condition</th>
          <th className="num" scope="col">Trials</th>
          <th className="num" scope="col">Failure rate</th>
          <th className="num" scope="col">Floor</th>
          <th scope="col">Outcome</th>
        </tr>
      </thead>
      <tbody>
        {matrix.map((entry) => {
          const tone = resultTone(entry.result)
          return <tr key={entry.label}>
            <th className="mono" scope="row">{entry.label}</th>
            <td className="num"><TrialCounts result={entry.result} /></td>
            <td className="num"><RateCell rate={entry.result.failureRate} /></td>
            <td className="num mono">{percent(entry.result.lowerBound80)}</td>
            <td><Tag label={tone === "pass" ? "PASS" : "FAIL"} tone={tone} /></td>
          </tr>
        })}
      </tbody>
    </table>
  </TableScroll></>
}

export function ProofSection({ report }: Readonly<{
  report: EvidenceReport
}>): React.JSX.Element {
  const { proof } = report
  return <Section
    id="proof"
    meta={proof.execution}
    ordinal="06"
    title="Proof of repair"
  >
    <HostileDelta matrix={proof.matrix} />
    <div className="static-checks">
      <span className="static-checks-label">Static checks</span>
      <CheckTag label="typecheck" passed={proof.staticChecks.typecheck} />
      <CheckTag label="eslint" passed={proof.staticChecks.lint} />
    </div>
    {proof.resources && <p className="table-note">
      Solari resources: {proof.resources.created} created · {proof.resources.released} released
      {` · ${proof.resources.live} live`}
    </p>}
    {report.repository && <p className="table-note">
      Repository fingerprint: <span className="mono">{report.repository.fingerprint}</span>
      {` · drift ${report.repository.drift}`}
    </p>}
    <MatrixTable matrix={proof.matrix} />
  </Section>
}
