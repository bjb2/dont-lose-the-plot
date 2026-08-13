import { join } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { z } from "zod"
import { loadTaxonomy } from "./config.js"
import { readJson, readUtf8, sha256, stableStringify, writeJson, writeUtf8 } from "./files.js"
import {
  DiscoveryResultSchema,
  TaxonomyAttributeSchema,
  TaxonomySchema,
  type Taxonomy,
  type TaxonomyCategory,
} from "./model.js"

const DecisionSchema = z.object({
  id: z.string(),
  recommendedAs: z.string().optional(),
  decision: z.enum(["pending", "category", "tag", "attribute", "relationship", "ignore", "merge"]),
  mergeInto: z.string().nullable().optional(),
  folder: z.string().optional(),
  attributes: z.record(z.string(), TaxonomyAttributeSchema).default({}),
})

const DecisionFileSchema = z.object({
  schemaVersion: z.literal(1),
  proposals: z.array(DecisionSchema),
  passageKinds: z.record(z.string(), z.boolean()).default({}),
  relations: z.record(z.string(), z.boolean()).default({}),
})

export async function applyTaxonomyOnboarding(
  root: string,
  options: { acceptRecommended?: boolean; decisionsPath?: string } = {},
): Promise<Taxonomy> {
  const discoveryPath = join(root, ".plot-tools", "review", "category-proposals.json")
  const decisionPath = options.decisionsPath
    ? join(root, options.decisionsPath)
    : join(root, ".plot-tools", "review", "taxonomy-decisions.yml")
  const discovery = await readJson(discoveryPath, DiscoveryResultSchema)
  const decisions = DecisionFileSchema.parse(parseYaml(await readUtf8(decisionPath)))
  const resolved = options.acceptRecommended
    ? {
        ...decisions,
        proposals: decisions.proposals.map((decision) => ({
          ...decision,
          decision: recommendedDecision(
            discovery.proposals.find((proposal) => proposal.id === decision.id)?.recommendedAs,
          ),
        })),
        passageKinds: Object.fromEntries(
          Object.keys(decisions.passageKinds).map((key) => [key, true]),
        ),
        relations: Object.fromEntries(Object.keys(decisions.relations).map((key) => [key, true])),
      }
    : decisions

  const pending = resolved.proposals.filter((decision) => decision.decision === "pending")
  if (pending.length > 0) {
    throw new Error(
      `Taxonomy decisions remain pending: ${pending.map((decision) => decision.id).join(", ")}`,
    )
  }

  const taxonomy = await loadTaxonomy(root)
  const categories = [...taxonomy.categories]
  for (const decision of resolved.proposals) {
    const proposal = discovery.proposals.find((candidate) => candidate.id === decision.id)
    if (!proposal) throw new Error(`Decision references unknown proposal ${decision.id}`)
    if (decision.decision === "category") {
      const proposedCategory: TaxonomyCategory = {
        id: proposal.id,
        labels: proposal.labels,
        definition: proposal.definition,
        include: proposal.include,
        exclude: proposal.exclude,
        tags: [],
        attributes: decision.attributes,
        relations: proposal.commonRelations,
        folder: decision.folder ?? proposal.labels.plural,
        pageTemplate: "entity",
      }
      const existing = categories.find((category) => category.id === proposal.id)
      if (existing) {
        if (stableStringify(existing) !== stableStringify(proposedCategory)) {
          throw new Error(`Category ${proposal.id} already exists with a different definition`)
        }
      } else {
        categories.push(proposedCategory)
      }
      continue
    }
    applyNonCategoryDecision(categories, decision, proposal.id)
  }

  const next = TaxonomySchema.parse({
    schemaVersion: 1,
    categories,
    passageKinds: unique([
      ...taxonomy.passageKinds,
      ...Object.entries(resolved.passageKinds)
        .filter(([, accepted]) => accepted)
        .map(([kind]) => kind),
    ]),
    relationVocabulary: unique([
      ...taxonomy.relationVocabulary,
      ...Object.entries(resolved.relations)
        .filter(([, accepted]) => accepted)
        .map(([relation]) => relation),
    ]),
  })

  const taxonomyText = stringifyYaml(next)
  await writeUtf8(join(root, "taxonomy.yml"), taxonomyText)
  await writeJson(join(root, "taxonomy.lock.json"), {
    schemaVersion: 1,
    taxonomyHash: sha256(stableStringify(next)),
    lockedAt: new Date().toISOString(),
    taxonomy: next,
  })
  return next
}

export async function lockExistingTaxonomy(root: string): Promise<Taxonomy> {
  const taxonomy = await loadTaxonomy(root)
  await writeJson(join(root, "taxonomy.lock.json"), {
    schemaVersion: 1,
    taxonomyHash: sha256(stableStringify(taxonomy)),
    lockedAt: new Date().toISOString(),
    taxonomy,
  })
  return taxonomy
}

function recommendedDecision(
  value: string | undefined,
): z.infer<typeof DecisionSchema>["decision"] {
  if (
    value === "category" ||
    value === "tag" ||
    value === "attribute" ||
    value === "relationship"
  ) {
    return value
  }
  return "ignore"
}

function applyNonCategoryDecision(
  categories: TaxonomyCategory[],
  decision: z.infer<typeof DecisionSchema>,
  proposalId: string,
): void {
  if (decision.decision === "ignore") return
  const targetId = decision.mergeInto
  if (!targetId) {
    throw new Error(`${decision.decision} decision for ${proposalId} requires mergeInto`)
  }
  const target = categories.find((category) => category.id === targetId)
  if (!target) throw new Error(`Decision target category ${targetId} does not exist`)
  if (decision.decision === "tag") target.tags = unique([...target.tags, proposalId])
  if (decision.decision === "attribute") {
    target.attributes[proposalId] = {
      type: "string",
      required: false,
      description: `Discovered corpus attribute: ${proposalId}`,
    }
  }
  if (decision.decision === "relationship")
    target.relations = unique([...target.relations, proposalId])
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}
