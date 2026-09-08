import { writeFile } from "node:fs/promises"
import { relative } from "node:path"

import type {
  FullResult,
  Reporter,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter"

const MAX_FAILURE_LENGTH = 2_000

interface TrialReporterOutput {
  artifacts: Array<{ contentType: string; name: string; path: string }>
  failures: string[]
  status: FullResult["status"]
}

function failureText(test: TestCase, result: TestResult): string | undefined {
  const message = result.error?.message?.trim()
  if (!message) {
    return undefined
  }
  const file = relative(process.cwd(), test.location.file).replaceAll("\\", "/")
  const location = `${file}:${test.location.line}:${test.location.column}`
  const identity = [test.parent.project()?.name, location, test.title]
    .filter((part) => part)
    .join(" › ")
  return `${identity}\n${message}`.slice(0, MAX_FAILURE_LENGTH)
}

export default class FlakeLabTrialReporter implements Reporter {
  private readonly artifacts: TrialReporterOutput["artifacts"] = []
  private readonly failures: string[] = []

  onTestEnd(test: TestCase, result: TestResult): void {
    const failure = failureText(test, result)
    if (failure) {
      this.failures.push(failure)
    }
    for (const attachment of result.attachments) {
      if (attachment.path && this.artifacts.length < 5) {
        this.artifacts.push({
          contentType: attachment.contentType,
          name: attachment.name,
          path: attachment.path,
        })
      }
    }
  }

  onError(error: TestError): void {
    const message = error.message?.trim()
    if (message) {
      this.failures.push(message.slice(0, MAX_FAILURE_LENGTH))
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    const path = process.env.FLAKELAB_TRIAL_REPORT_PATH
    if (!path) {
      return
    }
    const output: TrialReporterOutput = {
      artifacts: this.artifacts,
      failures: this.failures.slice(0, 10),
      status: result.status,
    }
    await writeFile(path, `${JSON.stringify(output)}\n`, "utf8")
  }
}
