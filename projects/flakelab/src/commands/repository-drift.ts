import {
  assertRepositoryUnchanged,
  isRepositoryDriftError,
} from "../project/profile.js"
import type { RepositoryProfile } from "../project/schema.js"

export async function verifyLocalRepository(
  repository: RepositoryProfile,
  restartCount: number,
  restart: () => Promise<void>,
): Promise<boolean> {
  try {
    await assertRepositoryUnchanged(repository)
    return true
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("Repository verification failed")
    if (!isRepositoryDriftError(error) || restartCount > 0) throw error
    await restart()
    return false
  }
}
