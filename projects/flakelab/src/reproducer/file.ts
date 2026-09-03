import { parse, stringify } from "yaml"

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { Reproducer } from "./schema.js"
import { reproducerSchema } from "./schema.js"

export async function readReproducer(filePath: string): Promise<Reproducer> {
  const contents = await readFile(filePath, "utf8")
  return reproducerSchema.parse(parse(contents))
}

export async function writeReproducer(filePath: string, value: Reproducer): Promise<void> {
  const reproducer = reproducerSchema.parse(value)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, stringify(reproducer), { encoding: "utf8" })
}
