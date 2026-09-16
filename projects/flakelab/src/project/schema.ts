import { z } from "zod"

export const repositoryTestSchema = z.object({
  column: z.number().int().positive(),
  file: z.string().min(1),
  line: z.number().int().positive(),
  projects: z.array(z.string()).min(1),
  title: z.string().min(1),
})

export const portableRepositoryProfileSchema = z.object({
  artifactRoot: z.string().min(1),
  discoveredAt: z.iso.datetime(),
  executionDirectory: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  installDirectory: z.string().min(1),
  invocationDirectory: z.string().min(1),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]),
  playwright: z.object({
    cli: z.string().min(1),
    config: z.string().min(1),
    configuredRetries: z.number().int().nonnegative(),
    target: z.string().min(1),
    test: repositoryTestSchema,
  }),
  projectDirectory: z.string(),
  reasons: z.array(z.string().min(1)),
  sourceDirectories: z.array(z.string().min(1)).min(1),
  taskRunner: z.enum(["nx", "turbo", "package-scripts"]),
  workspaceDirectory: z.literal("."),
}).strict()

export type PortableRepositoryProfile = z.infer<typeof portableRepositoryProfileSchema>
export type RepositoryTest = z.infer<typeof repositoryTestSchema>

export interface RepositoryProfile {
  artifactRoot: string
  discoveredAt: string
  executionRoot: string
  fingerprint: string
  installRoot: string
  invocationRoot: string
  packageManager: PortableRepositoryProfile["packageManager"]
  playwright: {
    cliPath: string
    configPath: string
    configuredRetries: number
    target: string
    test: RepositoryTest
  }
  projectDirectory: string
  reasons: string[]
  sourceRoots: string[]
  taskRunner: PortableRepositoryProfile["taskRunner"]
  workspaceRoot: string
}
