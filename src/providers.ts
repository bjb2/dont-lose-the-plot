import { join, resolve } from "node:path"
import { generateText, Output } from "ai"
import { z } from "zod"
import type { ProjectConfig } from "./model.js"
import { readUtf8 } from "./files.js"

export interface GenerationRequest<T> {
  key: string
  stage: string
  instructions: string
  prompt: string
  schema: z.ZodType<T>
}

export interface StructuredProvider {
  readonly name: string
  readonly model: string | null
  generate<T>(request: GenerationRequest<T>): Promise<T>
}

export class GatewayProvider implements StructuredProvider {
  readonly name = "vercel-ai-gateway"

  constructor(readonly model: string) {}

  async generate<T>(request: GenerationRequest<T>): Promise<T> {
    const { output } = await generateText({
      model: this.model,
      instructions: request.instructions,
      prompt: request.prompt,
      output: Output.object({ schema: request.schema }),
      temperature: 0,
    })
    return request.schema.parse(output)
  }
}

const RecordingFileSchema = z.object({
  schemaVersion: z.literal(1),
  responses: z.record(z.string(), z.unknown()),
})

export class RecordedProvider implements StructuredProvider {
  readonly name = "recorded"
  readonly model = null
  private recordings: z.infer<typeof RecordingFileSchema> | null = null

  constructor(private readonly path: string) {}

  async generate<T>(request: GenerationRequest<T>): Promise<T> {
    this.recordings ??= RecordingFileSchema.parse(JSON.parse(await readUtf8(this.path)))
    const response = this.recordings.responses[request.key]
    if (response === undefined) {
      throw new Error(`No recorded response for ${request.key} in ${this.path}`)
    }
    return request.schema.parse(response)
  }
}

export function createProvider(config: ProjectConfig, root: string): StructuredProvider {
  return config.provider.kind === "gateway"
    ? new GatewayProvider(config.provider.model)
    : new RecordedProvider(resolve(root, config.provider.recordings))
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
