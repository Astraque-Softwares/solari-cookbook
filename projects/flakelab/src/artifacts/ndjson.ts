import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { RunEvent } from "../domain/schema.js"
import { runEventSchema } from "../domain/schema.js"


export type EventWriter = (event: RunEvent) => Promise<void>

export function createNdjsonWriter(filePath: string): EventWriter {
  let pendingWrite = Promise.resolve()
  return (event) => {
    const write = pendingWrite.then(async () => {
      const validatedEvent = runEventSchema.parse(event)
      await mkdir(dirname(filePath), { recursive: true })
      await appendFile(filePath, `${JSON.stringify(validatedEvent)}\n`, { encoding: "utf8" })
    })
    pendingWrite = write.catch(() => undefined)
    return write
  }
}
