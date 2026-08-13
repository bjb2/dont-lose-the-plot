import { join } from "node:path"
import { z } from "zod"
import { loadProjectConfig, loadTaxonomy } from "./config.js"
import {
  readJson,
  readJsonLines,
  readUtf8,
  sha256,
  stableStringify,
  writeJson,
  writeJsonLines,
} from "./files.js"
import {
  SegmentExtractionSchema,
  SegmentSchema,
  TaxonomySchema,
  type SegmentExtraction,
} from "./model.js"
import { createProvider, loadPrompt, renderPrompt, type StructuredProvider } from "./providers.js"
import { completeRun, failRun, startRun } from "./runs.js"

const TaxonomyLockSchema = z.object({
  schemaVersion: z.literal(1),
  taxonomyHash: z.string().length(64),
  lockedAt: z.string(),
  taxonomy: TaxonomySchema,
})

export async function extractSegments(
  root: string,
  options: { provider?: StructuredProvider } = {},
): Promise<SegmentExtraction[]> {
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

  const provider = options.provider ?? createProvider(config, root)
  const prompt = await loadPrompt("segment-extraction")
  const promptVersion = (
    await readUtf8(join(import.meta.dirname, "..", "prompts", "segment-extraction", "VERSION"))
  ).trim()
  const run = await startRun({
    root,
    command: "extract",
    provider: provider.name,
    model: provider.model,
    taxonomy,
    promptVersions: { "segment-extraction": promptVersion },
    inputHashes: Object.fromEntries(segments.map((segment) => [segment.id, segment.sha256])),
  })

  try {
    const extractions = new Array<SegmentExtraction | undefined>(segments.length)
    const outputHashes: Record<string, string> = {}
    let nextIndex = 0
    let failure: unknown
    let failed = false
    const worker = async (): Promise<void> => {
      while (!failed) {
        const index = nextIndex
        nextIndex += 1
        const segment = segments[index]
        if (!segment) return
        try {
          const extraction = await provider.generate({
            key: `extract:${segment.id}`,
            stage: "segment-extraction",
            instructions: prompt.instructions,
            prompt: renderPrompt(prompt.template, {
              TAXONOMY: stableStringify(taxonomy),
              SEGMENT_ID: segment.id,
              ORDINAL: String(segment.ordinal),
              TITLE: segment.title,
              TEXT: segment.text,
            }),
            schema: SegmentExtractionSchema,
          })
          if (extraction.segmentId !== segment.id) {
            throw new Error(
              `Provider returned segmentId ${extraction.segmentId} while extracting ${segment.id}`,
            )
          }
          extractions[index] = extraction
          const rawPath = join(root, ".plot-tools", "raw", `${segment.id}.json`)
          await writeJson(rawPath, extraction)
          outputHashes[rawPath] = sha256(stableStringify(extraction))
        } catch (error) {
          if (!failed) failure = error
          failed = true
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(config.processing.concurrency, segments.length) }, () =>
        worker(),
      ),
    )
    if (failed) throw failure
    const orderedExtractions = extractions.map((extraction, index) => {
      if (!extraction) throw new Error(`Extraction worker omitted ${segments[index]?.id ?? index}`)
      return extraction
    })
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
