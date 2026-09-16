import { writeFile } from "node:fs/promises"
import { basename, dirname, extname, resolve } from "node:path"

import type { AutomaticFaultScreening } from "../discovery/automatic.js"

export interface NoSignalDiscoveryResult {
  screenings: AutomaticFaultScreening[]
  status: "no-signal-observed"
  trials: number
}

export function discoveryPathFor(outputPath: string): string {
  return resolve(
    dirname(outputPath),
    `${basename(outputPath, extname(outputPath))}.discovery.json`,
  )
}

export async function writeNoSignalDiscovery(
  outputPath: string,
  screenings: AutomaticFaultScreening[],
): Promise<{ discoveryPath: string; result: NoSignalDiscoveryResult }> {
  const result: NoSignalDiscoveryResult = {
    screenings,
    status: "no-signal-observed",
    trials: screenings.reduce((total, entry) => total + entry.trials, 0),
  }
  const discoveryPath = discoveryPathFor(outputPath)
  await writeFile(discoveryPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8" })
  return { discoveryPath, result }
}
