import { join, resolve } from "node:path"
import { z } from "zod"
import type { ProjectConfig } from "./model.js"
import { readJson, readUtf8 } from "./files.js"

const RecordingFileSchema = z.object({
  schemaVersion: z.literal(1),
  responses: z.record(z.string(), z.unknown()),
})

export async function loadStructuredResponse<T>(options: {
  config: ProjectConfig
  root: string
  key: string
  schema: z.ZodType<T>
  responsePath?: string
}): Promise<T> {
  if (options.responsePath) {
    return readJson(resolve(options.root, options.responsePath), options.schema)
  }
  if (options.config.recordings) {
    const recordings = await readJson(
      resolve(options.root, options.config.recordings),
      RecordingFileSchema,
    )
    const response = recordings.responses[options.key]
    if (response === undefined) {
      throw new Error(`No recorded response for ${options.key} in ${options.config.recordings}`)
    }
    return options.schema.parse(response)
  }
  throw new Error(
    `No OMP response supplied for ${options.key}; run plot-tools prepare and complete the work in an interactive OMP session`,
  )
}

export async function loadPrompt(stage: string): Promise<{
  instructions: string
  template: string
}> {
  const packageRoot = resolve(import.meta.dirname, "..")
  const directory = join(packageRoot, "prompts", stage)
  return {
    instructions: await readUtf8(join(directory, "system.md")),
    template: await readUtf8(join(directory, "instructions.md")),
  }
}

export function renderPrompt(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => variables[key] ?? match)
}
