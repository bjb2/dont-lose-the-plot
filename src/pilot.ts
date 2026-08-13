import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { stringify as stringifyYaml } from "yaml"
import { loadProjectConfig, loadTaxonomy } from "./config.js"
import { readJsonLines, readUtf8, sha256, stableStringify, writeJson, writeUtf8 } from "./files.js"
import {
  SegmentSchema,
  TaxonomyPilotResultSchema,
  type Segment,
  type TaxonomyPilotResult,
} from "./model.js"
import { loadPrompt, loadStructuredResponse, renderPrompt } from "./responses.js"
import { completeRun, failRun, startRun } from "./runs.js"

export async function analyzeTaxonomyPilot(
  root: string,
  options: { responsePath?: string } = {},
): Promise<TaxonomyPilotResult> {
  const config = await loadProjectConfig(root)
  const taxonomy = await loadTaxonomy(root)
  const segments = await readJsonLines(
    join(root, config.output.data, "segments.jsonl"),
    SegmentSchema,
  )
  if (segments.length === 0) throw new Error("No segments found; run plot-tools ingest first")

  const promptVersion = (
    await readUtf8(join(import.meta.dirname, "..", "prompts", "taxonomy-pilot", "VERSION"))
  ).trim()
  const samples = selectPilotSegments(segments)
  const run = await startRun({
    root,
    command: "pilot",
    responseSource: options.responsePath || !config.recordings ? "omp" : "recorded",
    taxonomy,
    promptVersions: { "taxonomy-pilot": promptVersion },
    inputHashes: Object.fromEntries(samples.map((segment) => [segment.id, segment.sha256])),
  })

  try {
    const result = await loadStructuredResponse({
      config,
      root,
      key: "pilot",
      schema: TaxonomyPilotResultSchema,
      ...(options.responsePath ? { responsePath: options.responsePath } : {}),
    })
    validatePilotEvidence(result, samples)
    const outputPath = join(root, ".plot-tools", "review", "taxonomy-pilot.json")
    const questionsPath = join(root, ".plot-tools", "review", "taxonomy-questions.json")
    const onboardingPath = join(root, ".plot-tools", "review", "taxonomy-decisions.yml")
    await writeJson(outputPath, result)
    await writeJson(questionsPath, createTaxonomyQuestions(result, samples))
    await writeUtf8(onboardingPath, stringifyYaml(createDecisionDraft(result)))
    await completeRun(root, run, {
      [outputPath]: sha256(stableStringify(result)),
      [questionsPath]: sha256(await readUtf8(questionsPath)),
      [onboardingPath]: sha256(await readUtf8(onboardingPath)),
    })
    return result
  } catch (error) {
    await failRun(root, run, error)
    throw error
  }
}

export async function prepareTaxonomyPilot(root: string): Promise<{
  work: string
  schema: string
  response: string
  segments: Array<{ id: string; ordinal: number; title: string }>
}> {
  const config = await loadProjectConfig(root)
  const taxonomy = await loadTaxonomy(root)
  const segments = await readJsonLines(
    join(root, config.output.data, "segments.jsonl"),
    SegmentSchema,
  )
  if (segments.length === 0) throw new Error("No segments found; run plot-tools ingest first")
  const prompt = await loadPrompt("taxonomy-pilot")
  const samples = selectPilotSegments(segments)
  const workPath = join(root, ".plot-tools", "work", "taxonomy-pilot.md")
  const schemaPath = join(root, ".plot-tools", "work", "taxonomy-pilot.schema.json")
  const responsePath = join(root, ".plot-tools", "responses", "taxonomy-pilot.json")
  await rm(responsePath, { force: true })
  await writeUtf8(
    workPath,
    [
      "# Taxonomy pilot work item",
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
              `--- ${segment.id} | ${segment.title} ---\n${renderPilotSegmentText(segment.text)}`,
          )
          .join("\n\n"),
      }),
      "",
    ].join("\n"),
  )
  await writeUtf8(
    schemaPath,
    await readUtf8(resolve(import.meta.dirname, "..", "schemas", "pilot.schema.json")),
  )
  return {
    work: workPath,
    schema: schemaPath,
    response: responsePath,
    segments: samples.map(({ id, ordinal, title }) => ({ id, ordinal, title })),
  }
}

export function selectPilotSegments(segments: Segment[], limit = 6): Segment[] {
  if (segments.length <= limit) return [...segments]
  const indexes = new Set<number>()
  for (let index = 0; index < limit; index += 1) {
    indexes.add(Math.round((index * (segments.length - 1)) / (limit - 1)))
  }
  return [...indexes].map((index) => segments[index]!).sort((a, b) => a.ordinal - b.ordinal)
}

function renderPilotSegmentText(text: string, limit = 12_000): string {
  if (text.length <= limit) return text
  const sliceLength = Math.floor(limit / 3)
  const middleStart = Math.floor((text.length - sliceLength) / 2)
  return [
    text.slice(0, sliceLength),
    "[... middle sample ...]",
    text.slice(middleStart, middleStart + sliceLength),
    "[... ending sample ...]",
    text.slice(-sliceLength),
  ].join("\n\n")
}

export function createTaxonomyQuestions(result: TaxonomyPilotResult, samples: Segment[]): unknown {
  return {
    schemaVersion: 1,
    checkpoint: "before-full-extraction",
    pilotSegments: samples.map(({ id, ordinal, title }) => ({ id, ordinal, title })),
    proposalQuestions: result.proposals.map((proposal) => ({
      id: proposal.id,
      prompt: `How should “${proposal.labels.singular}” be represented in the graph?`,
      recommendation: proposal.recommendedAs,
      reason: proposal.readerValue,
      confidence: proposal.confidence,
      options: ["category", "tag", "attribute", "relationship", "ignore"],
      mergeInto: proposal.mergeInto,
      targetRequired:
        proposal.recommendedAs === "tag" ||
        proposal.recommendedAs === "attribute" ||
        proposal.recommendedAs === "relationship",
      evidence: proposal.examples.slice(0, 3),
    })),
    relationSuggestions: result.proposedRelations,
    passageKindSuggestions: result.proposedPassageKinds,
  }
}

function validatePilotEvidence(result: TaxonomyPilotResult, samples: Segment[]): void {
  const byId = new Map(samples.map((segment) => [segment.id, segment]))
  for (const proposal of result.proposals) {
    const evidenceSegments = new Set<string>()
    for (const example of proposal.examples) {
      const segment = byId.get(example.segmentId)
      if (!segment) {
        throw new Error(
          `Pilot proposal ${proposal.id} cites segment ${example.segmentId}, which was not in the pilot`,
        )
      }
      if (!segment.text.includes(example.evidence)) {
        throw new Error(
          `Pilot proposal ${proposal.id} contains evidence that is not an exact source substring`,
        )
      }
      evidenceSegments.add(example.segmentId)
    }
    if (evidenceSegments.size < Math.min(2, samples.length)) {
      throw new Error(
        `Pilot proposal ${proposal.id} needs evidence from at least two pilot segments`,
      )
    }
  }
}

function createDecisionDraft(result: TaxonomyPilotResult): unknown {
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
