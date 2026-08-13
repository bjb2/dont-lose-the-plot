import { join } from "node:path"
import { stringify as stringifyYaml } from "yaml"
import { loadProjectConfig, loadTaxonomy } from "./config.js"
import { readJsonLines, readUtf8, sha256, stableStringify, writeJson, writeUtf8 } from "./files.js"
import {
  DiscoveryResultSchema,
  SegmentSchema,
  type DiscoveryResult,
  type Segment,
} from "./model.js"
import { createProvider, loadPrompt, renderPrompt } from "./providers.js"
import { completeRun, failRun, startRun } from "./runs.js"

export async function discoverCorpus(root: string): Promise<DiscoveryResult> {
  const config = await loadProjectConfig(root)
  const taxonomy = await loadTaxonomy(root)
  const segments = await readJsonLines(
    join(root, config.output.data, "segments.jsonl"),
    SegmentSchema,
  )
  if (segments.length === 0) throw new Error("No segments found; run plot-tools ingest first")

  const provider = createProvider(config, root)
  const prompt = await loadPrompt("corpus-discovery")
  const promptVersion = (
    await readUtf8(join(import.meta.dirname, "..", "prompts", "corpus-discovery", "VERSION"))
  ).trim()
  const samples = selectStratifiedSamples(segments)
  const run = await startRun({
    root,
    command: "discover",
    provider: provider.name,
    model: provider.model,
    taxonomy,
    promptVersions: { "corpus-discovery": promptVersion },
    inputHashes: Object.fromEntries(samples.map((segment) => [segment.id, segment.sha256])),
  })

  try {
    const result = await provider.generate({
      key: "discovery",
      stage: "corpus-discovery",
      instructions: prompt.instructions,
      prompt: renderPrompt(prompt.template, {
        PROFILE: config.profile,
        TAXONOMY: stableStringify(taxonomy),
        SAMPLES: samples
          .map(
            (segment) =>
              `--- ${segment.id} | ${segment.title} ---\n${segment.text.slice(0, 12_000)}`,
          )
          .join("\n\n"),
      }),
      schema: DiscoveryResultSchema,
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
