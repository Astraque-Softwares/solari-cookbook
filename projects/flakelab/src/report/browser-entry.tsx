import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { ReportApp } from "./report-app.js"
import "./report.css"
import { evidenceReportSchema } from "./schema.js"

const dataElement = document.querySelector<HTMLScriptElement>("#flakelab-report")
const rootElement = document.querySelector<HTMLElement>("#root")
if (!dataElement?.textContent || !rootElement) {
  throw new Error("FlakeLab report payload is missing")
}
const report = evidenceReportSchema.parse(JSON.parse(dataElement.textContent))
createRoot(rootElement).render(<StrictMode><ReportApp report={report} /></StrictMode>)
