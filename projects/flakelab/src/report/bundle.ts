import { build } from "vite"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import type { EvidenceReport } from "./schema.js"

function escapeEmbeddedJson(value: EvidenceReport): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function htmlDocument(report: EvidenceReport, script: string, styles: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>FlakeLab · ${escapeHtml(report.test)}</title>
  <style>${styles}</style>
</head>
<body>
  <div id="root"></div>
  <script id="flakelab-report" type="application/json">${escapeEmbeddedJson(report)}</script>
  <script type="module">${script.replaceAll("</script", "<\\/script")}</script>
</body>
</html>
`
}

export async function writePortableReport(
  projectRoot: string,
  outputPath: string,
  report: EvidenceReport,
): Promise<void> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: projectRoot,
    build: {
      cssCodeSplit: false,
      minify: true,
      write: false,
      rollupOptions: {
        input: resolve(projectRoot, "src/report/browser-entry.tsx"),
      },
    },
  })
  const outputs = Array.isArray(result) ? result : [result]
  const entries = outputs.flatMap((output) => "output" in output ? output.output : [])
  const script = entries.find((entry) => entry.type === "chunk" && entry.isEntry)
  const stylesheet = entries.find((entry) =>
    entry.type === "asset" && entry.fileName.endsWith(".css"))
  if (script?.type !== "chunk") {
    throw new Error("Vite did not produce the FlakeLab report script")
  }
  const styles = stylesheet?.type === "asset" ? stylesheet.source.toString() : ""
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, htmlDocument(report, script.code, styles), "utf8")
}
