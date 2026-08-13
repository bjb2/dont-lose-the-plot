import { join, resolve } from "node:path"
import { z } from "zod"
import { loadProjectConfig, loadTaxonomy } from "./config.js"
import {
  emptyDirectory,
  readJson,
  readJsonLines,
  readUtf8,
  sha256,
  stableStringify,
  writeJson,
  writeJsonLines,
  writeUtf8,
} from "./files.js"
import {
  SegmentExtractionSchema,
  SegmentSchema,
  TaxonomySchema,
  type SegmentExtraction,
} from "./model.js"
import { loadPrompt, loadStructuredResponse, renderPrompt } from "./responses.js"
import { completeRun, failRun, startRun } from "./runs.js"

const TaxonomyLockSchema = z.object({
  schemaVersion: z.literal(1),
  taxonomyHash: z.string().length(64),
  lockedAt: z.string(),
  taxonomy: TaxonomySchema,
})

export async function extractSegments(
  root: string,
  options: { responsesDir?: string } = {},
): Promise<SegmentExtraction[]> {
  const { config, taxonomy, segments } = await loadExtractionContext(root)
  const promptVersion = (
    await readUtf8(join(import.meta.dirname, "..", "prompts", "segment-extraction", "VERSION"))
  ).trim()
  const run = await startRun({
    root,
    command: "extract",
    responseSource: options.responsesDir || !config.recordings ? "omp" : "recorded",
    taxonomy,
    promptVersions: { "segment-extraction": promptVersion },
    inputHashes: Object.fromEntries(segments.map((segment) => [segment.id, segment.sha256])),
  })

  try {
    const responseRoot = options.responsesDir ? resolve(root, options.responsesDir) : undefined
    const outputHashes: Record<string, string> = {}
    const orderedExtractions = await Promise.all(
      segments.map(async (segment) => {
        const extraction = await loadStructuredResponse({
          config,
          root,
          key: `extract:${segment.id}`,
          schema: SegmentExtractionSchema,
          ...(responseRoot ? { responsePath: join(responseRoot, `${segment.id}.json`) } : {}),
        })
        if (extraction.segmentId !== segment.id) {
          throw new Error(
            `Response returned segmentId ${extraction.segmentId} while importing ${segment.id}`,
          )
        }
        const rawPath = join(root, ".plot-tools", "raw", `${segment.id}.json`)
        await writeJson(rawPath, extraction)
        outputHashes[rawPath] = sha256(stableStringify(extraction))
        return extraction
      }),
    )
    const extractionPath = join(root, config.output.data, "extractions.jsonl")
    await writeJsonLines(extractionPath, orderedExtractions)
    outputHashes[extractionPath] = sha256(await readUtf8(extractionPath))
    await completeRun(root, run, outputHashes)
    return orderedExtractions
  } catch (error) {
    await failRun(root, run, error)
    throw error
  }
}

export async function prepareExtractionWork(root: string): Promise<{
  work: string
  schema: string
  responses: string
  segments: number
  concurrency: number
}> {
  const { config, taxonomy, segments } = await loadExtractionContext(root)
  const prompt = await loadPrompt("segment-extraction")
  const workRoot = join(root, ".plot-tools", "work", "extractions")
  const responseRoot = join(root, ".plot-tools", "responses", "extractions")
  const schemaPath = join(workRoot, "_schema.json")
  await emptyDirectory(workRoot)
  await emptyDirectory(responseRoot)
  await writeUtf8(
    schemaPath,
    await readUtf8(resolve(import.meta.dirname, "..", "schemas", "extraction.schema.json")),
  )
  await Promise.all(
    segments.map(async (segment) => {
      const responsePath = join(responseRoot, `${segment.id}.json`)
      await writeUtf8(
        join(workRoot, `${segment.id}.md`),
        [
          `# Segment extraction: ${segment.title}`,
          "",
          `Write one JSON object to: ${responsePath}`,
          `The object must satisfy: ${schemaPath}`,
          "Do not wrap the JSON in Markdown.",
          "",
          "## Instructions",
          "",
          prompt.instructions,
          "",
          "## Request",
          "",
          renderPrompt(prompt.template, {
            TAXONOMY: stableStringify(taxonomy),
            SEGMENT_ID: segment.id,
            ORDINAL: String(segment.ordinal),
            TITLE: segment.title,
            TEXT: segment.text,
          }),
          "",
        ].join("\n"),
      )
    }),
  )
  return {
    work: workRoot,
    schema: schemaPath,
    responses: responseRoot,
    segments: segments.length,
    concurrency: config.processing.concurrency,
  }
}

async function loadExtractionContext(root: string) {
  const config = await loadProjectConfig(root)
  const taxonomy = await loadTaxonomy(root)
  const lock = await readJson(join(root, "taxonomy.lock.json"), TaxonomyLockSchema)
  const currentHash = sha256(stableStringify(taxonomy))
  if (lock.taxonomyHash !== currentHash) {
    throw new Error(
      "taxonomy.yml differs from taxonomy.lock.json; review and lock it before extraction",
    )
  }
  const segments = await readJsonLines(
    join(root, config.output.data, "segments.jsonl"),
    SegmentSchema,
  )
  if (segments.length === 0) throw new Error("No segments found; run plot-tools ingest first")
  return { config, taxonomy, segments }
}
