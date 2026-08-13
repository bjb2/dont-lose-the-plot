import { join } from "node:path"
import { loadProjectConfig } from "./config.js"
import { normalizeComparableText, readJsonLines, sha256, slugify, writeJsonLines } from "./files.js"
import {
  CanonicalClaimSchema,
  CanonicalEntitySchema,
  CanonicalPassageSchema,
  CanonicalRelationshipSchema,
  IssueSchema,
  MergeDecisionSchema,
  OpenQuestionSchema,
  SegmentExtractionSchema,
  SegmentSchema,
  type CanonicalClaim,
  type CanonicalEntity,
  type CanonicalPassage,
  type CanonicalRelationship,
  type Issue,
  type MergeDecision,
  type OpenQuestion,
  type Provenance,
  type Segment,
  type SegmentExtraction,
} from "./model.js"

export interface CanonicalGraph {
  entities: CanonicalEntity[]
  claims: CanonicalClaim[]
  relationships: CanonicalRelationship[]
  passages: CanonicalPassage[]
  questions: OpenQuestion[]
  merges: MergeDecision[]
  issues: Issue[]
}

interface Mention {
  extraction: SegmentExtraction["entities"][number]
  segment: Segment
}

export async function normalizeExtractions(root: string): Promise<CanonicalGraph> {
  const config = await loadProjectConfig(root)
  const dataRoot = join(root, config.output.data)
  const segments = await readJsonLines(join(dataRoot, "segments.jsonl"), SegmentSchema)
  const extractions = await readJsonLines(
    join(dataRoot, "extractions.jsonl"),
    SegmentExtractionSchema,
  )
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]))
  const issues: Issue[] = []
  const mentions: Mention[] = []

  for (const extraction of extractions) {
    const segment = segmentById.get(extraction.segmentId)
    if (!segment) {
      issues.push(
        issue("error", "unknown-segment", `Extraction references ${extraction.segmentId}`),
      )
      continue
    }
    for (const entity of extraction.entities) mentions.push({ extraction: entity, segment })
  }

  const groups = groupMentions(mentions, issues)
  const entities: CanonicalEntity[] = []
  const claims: CanonicalClaim[] = []
  const merges: MergeDecision[] = []
  const usedIds = new Set<string>()

  for (const group of groups) {
    const first = group[0]!
    const canonicalName = preferredCanonicalName(group.map(({ extraction }) => extraction.name))
    const entityId = allocateEntityId(first.extraction.category, canonicalName, usedIds)
    const provenance = group.map(({ extraction, segment }) =>
      provenanceFor(segment, extraction.excerpt),
    )
    const aliases = unique(
      group.flatMap(({ extraction }) => [extraction.name, ...extraction.aliases]),
    ).filter((name) => normalizeIdentityText(name) !== normalizeIdentityText(canonicalName))
    const entity = CanonicalEntitySchema.parse({
      id: entityId,
      category: first.extraction.category,
      canonicalName,
      aliases,
      summary: longest(group.map(({ extraction }) => extraction.summary)),
      salience: strongestSalience(group.map(({ extraction }) => extraction.salience)),
      certainty: strongestCertainty(group.map(({ extraction }) => extraction.certainty)),
      firstSeen: provenance.reduce((earliest, item) =>
        item.segmentOrdinal < earliest.segmentOrdinal ? item : earliest,
      ),
      mentions: dedupeProvenance(provenance),
      attributes: mergeAttributes(group, entityId, issues),
    })
    entities.push(entity)

    for (const { extraction, segment } of group) {
      if (normalizeIdentityText(extraction.name) !== normalizeIdentityText(entity.canonicalName)) {
        merges.push(
          MergeDecisionSchema.parse({
            canonicalEntityId: entity.id,
            mergedName: extraction.name,
            reason: "Unambiguous normalized name or alias match within the same category",
            automatic: true,
          }),
        )
      }
      extraction.claims.forEach((claim, index) => {
        claims.push(
          CanonicalClaimSchema.parse({
            id: stableId("claim", entity.id, segment.id, String(index), claim.text),
            entityId: entity.id,
            text: claim.text,
            certainty: claim.certainty,
            provenance: provenanceFor(segment, claim.excerpt),
          }),
        )
      })
    }
  }

  const aliases = buildAliasIndex(entities, issues)
  const relationships: CanonicalRelationship[] = []
  const passages: CanonicalPassage[] = []
  const questions: OpenQuestion[] = []

  for (const extraction of extractions) {
    const segment = segmentById.get(extraction.segmentId)
    if (!segment) continue
    extraction.relationships.forEach((relationship, index) => {
      const subjectId = resolveEntity(relationship.subject, aliases)
      const literal = relationship.object.startsWith("literal:")
        ? relationship.object.slice("literal:".length).trim()
        : null
      const objectId = literal === null ? resolveEntity(relationship.object, aliases) : null
      if (!subjectId) {
        issues.push(
          issue(
            "error",
            "unresolved-subject",
            `Cannot resolve relationship subject ${relationship.subject}`,
            segment.id,
          ),
        )
        return
      }
      if (!objectId && literal === null) {
        issues.push(
          issue(
            "error",
            "unresolved-object",
            `Cannot resolve relationship object ${relationship.object}`,
            segment.id,
          ),
        )
        return
      }
      relationships.push(
        CanonicalRelationshipSchema.parse({
          id: stableId(
            "relation",
            segment.id,
            String(index),
            relationship.subject,
            relationship.predicate,
          ),
          subjectId,
          predicate: relationship.predicate,
          objectId,
          literalObject: literal,
          certainty: relationship.certainty,
          provenance: provenanceFor(segment, relationship.excerpt),
        }),
      )
    })

    extraction.passages.forEach((passage, index) => {
      const speakerId = passage.speaker ? resolveEntity(passage.speaker, aliases) : null
      const entityIds = passage.entities
        .map((name) => resolveEntity(name, aliases))
        .filter((id): id is string => id !== null)
      const unresolved = passage.entities.filter((name) => !resolveEntity(name, aliases))
      for (const name of unresolved) {
        issues.push(
          issue(
            "review",
            "unresolved-passage-entity",
            `Cannot resolve passage entity ${name}`,
            segment.id,
          ),
        )
      }
      passages.push(
        CanonicalPassageSchema.parse({
          id: stableId("passage", segment.id, String(index), passage.title),
          title: passage.title,
          kind: passage.kind,
          speakerId,
          text: passage.text,
          context: passage.context,
          significance: passage.significance,
          entityIds: unique(entityIds),
          complete: passage.complete,
          certainty: passage.certainty,
          provenance: provenanceFor(segment, passage.text),
        }),
      )
    })

    extraction.openQuestions.forEach((text, index) => {
      questions.push(
        OpenQuestionSchema.parse({
          id: stableId("question", segment.id, String(index), text),
          text,
          provenance: provenanceFor(segment),
        }),
      )
    })
  }

  const graph: CanonicalGraph = {
    entities: entities.sort(byId),
    claims: claims.sort(byId),
    relationships: relationships.sort(byId),
    passages: passages.sort(byId),
    questions: questions.sort(byId),
    merges: merges.sort((a, b) => a.mergedName.localeCompare(b.mergedName)),
    issues: issues.map((value, index) => IssueSchema.parse({ ...value, id: `issue-${index + 1}` })),
  }
  await Promise.all([
    writeJsonLines(join(dataRoot, "entities.jsonl"), graph.entities),
    writeJsonLines(join(dataRoot, "claims.jsonl"), graph.claims),
    writeJsonLines(join(dataRoot, "relationships.jsonl"), graph.relationships),
    writeJsonLines(join(dataRoot, "passages.jsonl"), graph.passages),
    writeJsonLines(join(dataRoot, "questions.jsonl"), graph.questions),
    writeJsonLines(join(dataRoot, "merges.jsonl"), graph.merges),
    writeJsonLines(join(root, ".plot-tools", "review", "issues.jsonl"), graph.issues),
  ])
  return graph
}

function groupMentions(mentions: Mention[], issues: Issue[]): Mention[][] {
  const canonicalKeys = new Map<string, Mention[]>()
  for (const mention of mentions) {
    const key = `${mention.extraction.category}:${normalizeIdentityText(mention.extraction.name)}`
    const group = canonicalKeys.get(key) ?? []
    group.push(mention)
    canonicalKeys.set(key, group)
  }

  const aliasToKeys = new Map<string, Set<string>>()
  for (const [key, group] of canonicalKeys) {
    for (const alias of group.flatMap(({ extraction }) => extraction.aliases)) {
      const aliasKey = `${group[0]!.extraction.category}:${normalizeIdentityText(alias)}`
      const owners = aliasToKeys.get(aliasKey) ?? new Set<string>()
      owners.add(key)
      aliasToKeys.set(aliasKey, owners)
    }
  }

  for (const [alias, owners] of aliasToKeys) {
    if (owners.size > 1) {
      issues.push(
        issue("review", "alias-collision", `Alias ${alias} maps to ${[...owners].join(", ")}`),
      )
    }
  }

  const consumed = new Set<string>()
  const groups: Mention[][] = []
  for (const [key, base] of [...canonicalKeys.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (consumed.has(key)) continue
    const merged = [...base]
    const owners = aliasToKeys.get(key)
    if (owners?.size === 1) {
      const owner = [...owners][0]!
      if (owner !== key && !consumed.has(owner)) {
        merged.push(...(canonicalKeys.get(owner) ?? []))
        consumed.add(owner)
      }
    }
    consumed.add(key)
    groups.push(merged.sort((a, b) => a.segment.ordinal - b.segment.ordinal))
  }
  return groups
}

function buildAliasIndex(entities: CanonicalEntity[], issues: Issue[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const entity of entities) {
    for (const name of [entity.canonicalName, ...entity.aliases]) {
      const key = normalizeIdentityText(name)
      const owners = index.get(key) ?? new Set<string>()
      owners.add(entity.id)
      index.set(key, owners)
    }
  }
  for (const [name, owners] of index) {
    if (owners.size > 1) {
      issues.push(
        issue("review", "global-alias-collision", `${name} maps to ${[...owners].join(", ")}`),
      )
    }
  }
  return index
}

function resolveEntity(name: string, aliases: Map<string, Set<string>>): string | null {
  const owners = aliases.get(normalizeIdentityText(name))
  return owners?.size === 1 ? [...owners][0]! : null
}

function normalizeIdentityText(value: string): string {
  return normalizeComparableText(value).toLocaleLowerCase()
}

function preferredCanonicalName(names: string[]): string {
  return [...names].sort((a, b) => {
    const capitalization = capitalizationScore(b) - capitalizationScore(a)
    return capitalization || a.localeCompare(b)
  })[0]!
}

function capitalizationScore(value: string): number {
  const firstLetter = value.match(/\p{L}/u)?.[0]
  if (!firstLetter) return 0
  return firstLetter === firstLetter.toLocaleUpperCase() &&
    firstLetter !== firstLetter.toLocaleLowerCase()
    ? 1
    : 0
}

function mergeAttributes(
  groups: Mention[],
  entityId: string,
  issues: Issue[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const { extraction } of groups) {
    for (const [key, value] of Object.entries(extraction.attributes)) {
      if (!(key in output)) output[key] = value
      else if (JSON.stringify(output[key]) !== JSON.stringify(value)) {
        issues.push(
          issue(
            "review",
            "attribute-conflict",
            `Conflicting ${key} values for ${entityId}`,
            undefined,
            entityId,
          ),
        )
      }
    }
  }
  return output
}

function provenanceFor(segment: Segment, excerpt?: string): Provenance {
  return {
    sourceId: segment.sourceId,
    segmentId: segment.id,
    segmentOrdinal: segment.ordinal,
    locator: segment.locator,
    ...(excerpt ? { excerpt } : {}),
  }
}

function dedupeProvenance(values: Provenance[]): Provenance[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = `${value.segmentId}:${value.excerpt ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function issue(
  severity: Issue["severity"],
  code: string,
  message: string,
  segmentId?: string,
  entityId?: string,
): Issue {
  return IssueSchema.parse({ id: "pending", severity, code, message, segmentId, entityId })
}

function allocateEntityId(category: string, name: string, used: Set<string>): string {
  const base = `${category}-${slugify(name) || "unnamed"}`
  const id = used.has(base) ? `${base}-${sha256(name).slice(0, 8)}` : base
  used.add(id)
  return id
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${sha256(parts.join("\u0000")).slice(0, 16)}`
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function longest(values: string[]): string {
  return values.reduce(
    (best, value) => (value.length > best.length ? value : best),
    values[0] ?? "",
  )
}

function strongestSalience(values: CanonicalEntity["salience"][]): CanonicalEntity["salience"] {
  const order = ["reference", "supporting", "primary"] as const
  return values.reduce(
    (best, value) => (order.indexOf(value) > order.indexOf(best) ? value : best),
    "reference",
  )
}

function strongestCertainty(values: CanonicalEntity["certainty"][]): CanonicalEntity["certainty"] {
  const order = ["unresolved", "inferred", "explicit"] as const
  return values.reduce(
    (best, value) => (order.indexOf(value) > order.indexOf(best) ? value : best),
    "unresolved",
  )
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id)
}
