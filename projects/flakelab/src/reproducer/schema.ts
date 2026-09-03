import { z } from "zod"

import { networkDelayFaultSchema } from "../domain/schema.js"

export const reproducerSchema = z.object({
  version: z.literal(1),
  test: z.string().min(1),
  seed: z.number().int().min(0).max(0xffff_ffff),
  trials: z.number().int().min(2).max(100),
  faults: z.array(networkDelayFaultSchema).length(1),
  expectedFailure: z.object({
    minimumRate: z.number().gt(0).max(1),
    signature: z.string().min(1).optional(),
  }),
})

export type Reproducer = z.infer<typeof reproducerSchema>
