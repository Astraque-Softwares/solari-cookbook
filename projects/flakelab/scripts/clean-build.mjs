import { rm } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const buildDirectory = resolve(projectRoot, "dist")
if (relative(projectRoot, buildDirectory) !== "dist") {
  throw new Error("Refusing to clean an unexpected build directory")
}

await rm(buildDirectory, { recursive: true, force: true })
