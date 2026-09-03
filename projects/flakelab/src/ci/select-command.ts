import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { parseArgs } from "node:util"

import { selectChangedTests } from "./changed-tests.js"

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function safeOutputValue(value: string): string {
  if (!/^[a-zA-Z0-9._\/-]*$/u.test(value)) {
    throw new Error("selected test path contains unsupported characters for GitHub output")
  }
  return value
}

async function writeGitHubOutput(path: string, test: string, count: number): Promise<void> {
  if (!isAbsolute(path) || /[\r\n\0]/u.test(path)) {
    throw new Error("GITHUB_OUTPUT must be an absolute file path")
  }
  await appendFile(
    path,
    `has_tests=${count > 0}\nfirst_test=${safeOutputValue(test)}\ntest_count=${count}\n`,
    "utf8",
  )
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      output: { type: "string", default: ".flakelab/changed-tests.json" },
    },
  })
  const selection = await selectChangedTests(
    process.cwd(),
    required(values.base, "--base"),
    values.head,
  )
  const outputPath = resolve(values.output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(selection, null, 2)}\n`, "utf8")
  const firstTest = selection.tests[0] ?? ""
  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput) {
    await writeGitHubOutput(githubOutput, firstTest, selection.tests.length)
  }
  console.log(JSON.stringify({ outputPath, ...selection }, null, 2))
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : "Changed-test selection failed")
  process.exitCode = 1
}
