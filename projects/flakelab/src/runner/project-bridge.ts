import { lstat, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

import type { Fault } from "../domain/schema.js"
import {
  browserContextFaultOptions,
  browserLaunchFaultArguments,
} from "../faults/browser-context.js"

const CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.cts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
]

export interface TemporaryProjectBridge {
  configPath: string
  remove: () => Promise<void>
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

export async function findPlaywrightConfig(projectRoot: string): Promise<string | undefined> {
  for (const name of CONFIG_NAMES) {
    const candidate = join(projectRoot, name)
    if (await regularFile(candidate)) {
      return candidate
    }
  }
  return undefined
}

function bridgeSource(
  configPath: string | undefined,
  reporterPath: string,
  faults: readonly Fault[],
  captureTrace: boolean,
): string {
  const configImportPath = configPath
    ? JSON.stringify(`./${basename(configPath)}`)
    : undefined
  const configImport = configPath
    ? `import userConfig from ${configImportPath}\n`
    : "const userConfig = {}\n"
  const contextFaults = JSON.stringify(browserContextFaultOptions(faults))
  const launchFaultArgs = JSON.stringify(browserLaunchFaultArguments(faults))
  return `${configImport}
const proxyServer = process.env.FLAKELAB_PROXY_URL
const proxy = proxyServer ? { server: proxyServer } : undefined
const contextFaults = ${contextFaults}
const launchFaultArgs = ${launchFaultArgs}
const withFaults = (use = {}) => ({
  ...use,
  ...contextFaults,
  ${captureTrace ? 'trace: "on",' : ""}
  contextOptions: { ...use.contextOptions, ...contextFaults },
  launchOptions: {
    ...use.launchOptions,
    args: [...(use.launchOptions?.args ?? []), ...launchFaultArgs],
  },
  ...(proxy ? { proxy } : {}),
})
const configuredReporters = userConfig.reporter
const reporters = configuredReporters === undefined
  ? [["line"]]
  : typeof configuredReporters === "string"
    ? [[configuredReporters]]
    : configuredReporters
const projects = Array.isArray(userConfig.projects)
  ? userConfig.projects.map((project) => ({ ...project, use: withFaults(project.use) }))
  : userConfig.projects

export default {
  ...userConfig,
  retries: 0,
  use: withFaults(userConfig.use),
  ...(projects ? { projects } : {}),
  reporter: [...reporters, [${JSON.stringify(reporterPath)}]],
}
`
}

export async function createTemporaryProjectBridge(
  projectRoot: string,
  reporterPath: string,
  faults: readonly Fault[] = [],
  captureTrace = false,
  configuredPath?: string,
): Promise<TemporaryProjectBridge> {
  const userConfigPath = configuredPath ?? await findPlaywrightConfig(projectRoot)
  const configDirectory = userConfigPath ? dirname(userConfigPath) : projectRoot
  const configPath = join(configDirectory, `.flakelab-${randomUUID()}.config.ts`)
  await writeFile(configPath, bridgeSource(
    userConfigPath,
    reporterPath,
    faults,
    captureTrace,
  ), {
    encoding: "utf8",
    flag: "wx",
  })
  return {
    configPath,
    remove: async () => rm(configPath, { force: true }),
  }
}
