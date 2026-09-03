import { execFile } from "node:child_process"
import { promisify } from "node:util"

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const execFileAsync = promisify(execFile)

export async function createRevisionArchive(
  repositoryRoot: string,
  revision: string,
): Promise<Buffer> {
  const result = await execFileAsync("git", ["archive", "--format=tar", revision], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: MAX_ARCHIVE_BYTES,
    windowsHide: true,
  })
  return result.stdout
}
