import { copyFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = fileURLToPath(new URL("../src/report/report.css", import.meta.url))
const destination = fileURLToPath(new URL("../dist/report/report.css", import.meta.url))

await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)

process.stdout.write(`Copied report assets from ${projectRoot}\n`)
