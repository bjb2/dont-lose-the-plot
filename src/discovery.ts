import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { stringify as stringifyYaml } from "yaml"
import { loadProjectConfig, loadTaxonomy } from "./config.js"
import { readJsonLines, readUtf8, sha256, stableStringify, writeJson, writeUtf8 } from "./files.js"
import {
  DiscoveryResultSchema,
  SegmentSchema,
  type DiscoveryResult,
  type Segment,
} from "./model.js"
import { loadPrompt, loadStructuredResponse, renderPrompt } from "./responses.js"
import { completeRun, failRun, startRun } from "./runs.js"

export async function discoverCorpus(
  root: string,
  options: { responsePath?: string } = {},
): Promise<DiscoveryResult> {
  const config = await loadProjectConfig(root)
  const taxonomy = await loadTaxonomy(root)
  const segments = await readJsonLines(
    join(root, config.output.data, "segments.jsonl"),
    SegmentSchema,
  )
  if (segments.length === 0) throw new Error("No segments found; run plot-tools ingest first")

  const promptVersion = (
    await readUtf8(join(import.meta.dirname, "..", "prompts", "corpus-discovery", "VERSION"))
  ).trim()
  const samples = selectStratifiedSamples(segments)
  const run = await startRun({
    root,
    command: "discover",
    responseSource: options.responsePath || !config.recordings ? "omp" : "recorded",
    taxonomy,
    promptVersions: { "corpus-discovery": promptVersion },
    inputHashes: Object.fromEntries(samples.map((segment) => [segment.id, segment.sha256])),
  })

  try {
    const result = await loadStructuredResponse({
      config,
      root,
      key: "discovery",
      schema: DiscoveryResultSchema,
      ...(options.responsePath ? { responsePath: options.responsePath } : {}),
    })
    const outputPath = join(root, ".plot-tools", "review", "category-proposals.json")
    const onboardingPath = join(root, ".plot-tools", "review", "taxonomy-decisions.yml")
    await writeJson(outputPath, result)
    await writeUtf8(onboardingPath, stringifyYaml(createDecisionDraft(result)))
    await completeRun(root, run, {
      [outputPath]: sha256(stableStringify(result)),
      [onboardingPath]: sha256(await readUtf8(onboardingPath)),
    })
    return result
  } catch (error) {
    await failRun(root, run, error)
    throw error
  }
}

export async function prepareDiscoveryWork(root: string): Promise<{
  work: string
  schema: string
  response: string
}> {
  const config = await loadProjectConfig(root)
  const taxonomy = await loadTaxonomy(root)
  const segments = await readJsonLines(
    join(root, config.output.data, "segments.jsonl"),
    SegmentSchema,
  )
  if (segments.length === 0) throw new Error("No segments found; run plot-tools ingest first")
  const prompt = await loadPrompt("corpus-discovery")
  const samples = selectStratifiedSamples(segments)
  const workPath = join(root, ".plot-tools", "work", "discovery.md")
  const schemaPath = join(root, ".plot-tools", "work", "discovery.schema.json")
  const responsePath = join(root, ".plot-tools", "responses", "discovery.json")
  await rm(responsePath, { force: true })
  await writeUtf8(
    workPath,
    [
      "# Corpus discovery work item",
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
        PROFILE: config.profile,
        TAXONOMY: stableStringify(taxonomy),
        SAMPLES: samples
          .map(
            (segment) =>
              `--- ${segment.id} | ${segment.title} ---\n${segment.text.slice(0, 12_000)}`,
          )
          .join("\n\n"),
      }),
      "",
    ].join("\n"),
  )
  await writeUtf8(
    schemaPath,
    await readUtf8(resolve(import.meta.dirname, "..", "schemas", "discovery.schema.json")),
  )
  return { work: workPath, schema: schemaPath, response: responsePath }
}

export function selectStratifiedSamples(segments: Segment[], limit = 7): Segment[] {
  if (segments.length <= limit) return [...segments]
  const indexes = new Set<number>()
  for (let index = 0; index < limit; index += 1) {
    indexes.add(Math.round((index * (segments.length - 1)) / (limit - 1)))
  }
  return [...indexes].map((index) => segments[index]!).sort((a, b) => a.ordinal - b.ordinal)
}

function createDecisionDraft(result: DiscoveryResult): unknown {
  return {
    schemaVersion: 1,
    proposals: result.proposals.map((proposal) => ({
      id: proposal.id,
      recommendedAs: proposal.recommendedAs,
      decision: "pending",
      mergeInto: proposal.mergeInto,
      folder: titleCase(proposal.labels.plural),
      attributes: Object.fromEntries(
        proposal.sharedAttributes.map((attribute) => [
          attribute.id,
          {
            type: attribute.type,
            required: false,
            description: attribute.description,
          },
        ]),
      ),
    })),
    passageKinds: Object.fromEntries(result.proposedPassageKinds.map((kind) => [kind, false])),
    relations: Object.fromEntries(result.proposedRelations.map((relation) => [relation, false])),
  }
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ")
}
