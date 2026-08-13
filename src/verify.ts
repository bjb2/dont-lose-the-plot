import { basename, extname, join, relative, sep } from "node:path"
import { z } from "zod"
import { loadProjectConfig, loadTaxonomy } from "./config.js"
import {
  listFilesRecursive,
  pathExists,
  readJson,
  readJsonLines,
  readUtf8,
  sha256,
  stableStringify,
  writeJson,
} from "./files.js"
import {
  CanonicalClaimSchema,
  CanonicalEntitySchema,
  CanonicalPassageSchema,
  CanonicalRelationshipSchema,
  GateResultSchema,
  IssueSchema,
  SegmentExtractionSchema,
  SegmentSchema,
  TaxonomySchema,
  VerificationReportSchema,
  type CanonicalClaim,
  type CanonicalEntity,
  type CanonicalPassage,
  type CanonicalRelationship,
  type GateResult,
  type Issue,
  type ProjectConfig,
  type Provenance,
  type Segment,
  type SegmentExtraction,
  type VerificationReport,
  type Taxonomy,
} from "./model.js"

const TaxonomyLockSchema = z.object({
  schemaVersion: z.literal(1),
  taxonomyHash: z.string().length(64),
  lockedAt: z.string(),
  taxonomy: TaxonomySchema,
})

interface LoadedArtifacts {
  config: ProjectConfig
  taxonomy: Taxonomy
  lock: z.infer<typeof TaxonomyLockSchema>
  segments: Segment[]
  extractions: SegmentExtraction[]
  entities: CanonicalEntity[]
  claims: CanonicalClaim[]
  relationships: CanonicalRelationship[]
  passages: CanonicalPassage[]
  issues: Issue[]
}

export async function verifyProject(root: string): Promise<VerificationReport> {
  const gates: GateResult[] = []
  let loaded: LoadedArtifacts
  try {
    loaded = await loadArtifacts(root)
    gates.push(pass("schema-contract", "All canonical artifacts satisfy their schemas"))
  } catch (error) {
    gates.push(fail("schema-contract", "Canonical artifact parsing failed", [message(error)]))
    return writeReport(root, gates)
  }

  const {
    config,
    taxonomy,
    lock,
    segments,
    extractions,
    entities,
    claims,
    relationships,
    passages,
    issues,
  } = loaded
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]))
  const entityIds = new Set(entities.map((entity) => entity.id))

  gates.push(
    checkCoverage(segments, extractions),
    checkOrdering(segments),
    lock.taxonomyHash === sha256(stableStringify(taxonomy))
      ? pass("taxonomy-lock", "taxonomy.yml matches the reviewed lock")
      : fail("taxonomy-lock", "taxonomy.yml changed after review"),
    checkTaxonomy(taxonomy, extractions),
    checkEvidence(segmentById, extractions),
    checkIdentity(entities, issues),
    checkEndpoints(entityIds, relationships),
    checkProvenance(segmentById, [
      ...entities.flatMap((entity) => entity.mentions),
      ...claims.map((claim) => claim.provenance),
      ...relationships.map((relationship) => relationship.provenance),
      ...passages.map((passage) => passage.provenance),
    ]),
    checkSpoilers(config.scope.maxSegment, [
      ...entities.flatMap((entity) => entity.mentions),
      ...claims.map((claim) => claim.provenance),
      ...relationships.map((relationship) => relationship.provenance),
      ...passages.map((passage) => passage.provenance),
    ]),
    checkOpenIssues(issues),
  )
  gates.push(await checkRawConsumption(root, segments))
  gates.push(await checkPublishedGraph(root, config.output.obsidian))
  return writeReport(root, gates)
}

async function loadArtifacts(root: string): Promise<LoadedArtifacts> {
  const config = await loadProjectConfig(root)
  const taxonomy = await loadTaxonomy(root)
  const dataRoot = join(root, config.output.data)
  return {
    config,
    taxonomy,
    lock: await readJson(join(root, "taxonomy.lock.json"), TaxonomyLockSchema),
    segments: await readJsonLines(join(dataRoot, "segments.jsonl"), SegmentSchema),
    extractions: await readJsonLines(join(dataRoot, "extractions.jsonl"), SegmentExtractionSchema),
    entities: await readJsonLines(join(dataRoot, "entities.jsonl"), CanonicalEntitySchema),
    claims: await readJsonLines(join(dataRoot, "claims.jsonl"), CanonicalClaimSchema),
    relationships: await readJsonLines(
      join(dataRoot, "relationships.jsonl"),
      CanonicalRelationshipSchema,
    ),
    passages: await readJsonLines(join(dataRoot, "passages.jsonl"), CanonicalPassageSchema),
    issues: await readJsonLines(join(root, ".plot-tools", "review", "issues.jsonl"), IssueSchema),
  }
}

function checkCoverage(segments: Segment[], extractions: SegmentExtraction[]): GateResult {
  const counts = new Map<string, number>()
  for (const extraction of extractions)
    counts.set(extraction.segmentId, (counts.get(extraction.segmentId) ?? 0) + 1)
  const details = segments
    .filter((segment) => counts.get(segment.id) !== 1)
    .map((segment) => `${segment.id}: ${counts.get(segment.id) ?? 0} extraction records`)
  const unknown = extractions
    .filter((extraction) => !segments.some((segment) => segment.id === extraction.segmentId))
    .map((extraction) => `Unknown extraction ${extraction.segmentId}`)
  return details.length + unknown.length === 0
    ? pass("source-coverage", `Exactly one extraction covers each of ${segments.length} segments`)
    : fail("source-coverage", "Extraction coverage is incomplete or duplicated", [
        ...details,
        ...unknown,
      ])
}

function checkOrdering(segments: Segment[]): GateResult {
  const details: string[] = []
  const bySource = Map.groupBy(segments, (segment) => segment.sourceId)
  for (const [sourceId, sourceSegments] of bySource) {
    const actual = sourceSegments.map((segment) => segment.ordinal).sort((a, b) => a - b)
    const expected = Array.from({ length: actual.length }, (_, index) => index + 1)
    if (actual.join(",") !== expected.join(",")) details.push(`${sourceId}: ${actual.join(", ")}`)
  }
  return details.length === 0
    ? pass("source-order", "Segment ordinals are contiguous within each source")
    : fail("source-order", "Segment ordinals are not contiguous", details)
}

function checkTaxonomy(taxonomy: Taxonomy, extractions: SegmentExtraction[]): GateResult {
  const categoryById = new Map(taxonomy.categories.map((category) => [category.id, category]))
  const passages = new Set(taxonomy.passageKinds)
  const relations = new Set([
    ...taxonomy.relationVocabulary,
    ...taxonomy.categories.flatMap((category) => category.relations),
  ])
  const details: string[] = []
  for (const extraction of extractions) {
    for (const entity of extraction.entities) {
      const category = categoryById.get(entity.category)
      if (!category) {
        details.push(`${extraction.segmentId}: category ${entity.category}`)
        continue
      }
      for (const [key, value] of Object.entries(entity.attributes)) {
        const attribute = category.attributes[key]
        if (!attribute)
          details.push(`${extraction.segmentId}: ${entity.category}.${key} is not locked`)
        else if (!matchesAttributeType(value, attribute.type)) {
          details.push(`${extraction.segmentId}: ${entity.category}.${key} has the wrong type`)
        }
      }
      for (const [key, attribute] of Object.entries(category.attributes)) {
        if (attribute.required && !(key in entity.attributes)) {
          details.push(`${extraction.segmentId}: ${entity.category}.${key} is required`)
        }
      }
    }
    for (const passage of extraction.passages) {
      if (!passages.has(passage.kind))
        details.push(`${extraction.segmentId}: passage kind ${passage.kind}`)
    }
    for (const relationship of extraction.relationships) {
      if (!relations.has(relationship.predicate)) {
        details.push(`${extraction.segmentId}: relation ${relationship.predicate}`)
      }
    }
  }
  return details.length === 0
    ? pass("taxonomy-conformance", "Every extracted type belongs to the locked taxonomy")
    : fail("taxonomy-conformance", "Extraction used unlocked taxonomy values", unique(details))
}

function matchesAttributeType(
  value: unknown,
  type: "string" | "number" | "boolean" | "string-list" | "entity-ref" | "object",
): boolean {
  if (type === "string" || type === "entity-ref") return typeof value === "string"
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  if (type === "boolean") return typeof value === "boolean"
  if (type === "string-list") {
    return Array.isArray(value) && value.every((item) => typeof item === "string")
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function checkEvidence(
  segmentById: Map<string, Segment>,
  extractions: SegmentExtraction[],
): GateResult {
  const details: string[] = []
  for (const extraction of extractions) {
    const segment = segmentById.get(extraction.segmentId)
    if (!segment) continue
    const excerpts = [
      ...extraction.entities.flatMap((entity) => [
        entity.excerpt,
        ...entity.claims.map((claim) => claim.excerpt),
      ]),
      ...extraction.relationships.map((relationship) => relationship.excerpt),
      ...extraction.passages.map((passage) => passage.text),
    ]
    excerpts.forEach((excerpt, index) => {
      if (!segment.text.includes(excerpt))
        details.push(`${segment.id} excerpt ${index + 1}: ${excerpt.slice(0, 80)}`)
    })
  }
  return details.length === 0
    ? pass("evidence-exactness", "Every excerpt is an exact substring of its source segment")
    : fail("evidence-exactness", "One or more excerpts are not present verbatim", details)
}

function checkIdentity(entities: CanonicalEntity[], issues: Issue[]): GateResult {
  const ids = entities.map((entity) => entity.id)
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index)
  const collisions = issues.filter((entry) => entry.code.includes("alias-collision"))
  const details = [
    ...duplicateIds.map((id) => `Duplicate ID ${id}`),
    ...collisions.map((entry) => entry.message),
  ]
  return details.length === 0
    ? pass("identity", "Entity IDs and aliases resolve unambiguously")
    : fail("identity", "Entity identity contains collisions", unique(details))
}

function checkEndpoints(
  entityIds: Set<string>,
  relationships: CanonicalRelationship[],
): GateResult {
  const details = relationships.flatMap((relationship) => {
    const missing: string[] = []
    if (!entityIds.has(relationship.subjectId))
      missing.push(`${relationship.id}: subject ${relationship.subjectId}`)
    if (relationship.objectId && !entityIds.has(relationship.objectId)) {
      missing.push(`${relationship.id}: object ${relationship.objectId}`)
    }
    if (!relationship.objectId && !relationship.literalObject)
      missing.push(`${relationship.id}: missing object`)
    return missing
  })
  return details.length === 0
    ? pass("relationship-endpoints", "Every relationship endpoint resolves")
    : fail("relationship-endpoints", "Relationships contain unresolved endpoints", details)
}

function checkProvenance(segmentById: Map<string, Segment>, values: Provenance[]): GateResult {
  const details = values.flatMap((value) => {
    const segment = segmentById.get(value.segmentId)
    if (!segment) return [`Unknown segment ${value.segmentId}`]
    return segment.sourceId === value.sourceId ? [] : [`${value.segmentId}: source mismatch`]
  })
  return details.length === 0
    ? pass("provenance", "Every canonical record points to an ingested segment")
    : fail("provenance", "Canonical records contain invalid provenance", unique(details))
}

function checkSpoilers(maxSegment: number | null, values: Provenance[]): GateResult {
  if (maxSegment === null) return pass("spoiler-boundary", "No segment boundary is configured")
  const violations = values.filter((value) => value.segmentOrdinal > maxSegment)
  return violations.length === 0
    ? pass("spoiler-boundary", `No record exceeds segment ${maxSegment}`)
    : fail("spoiler-boundary", `${violations.length} records exceed segment ${maxSegment}`)
}

function checkOpenIssues(issues: Issue[]): GateResult {
  const blocking = issues.filter((entry) => entry.severity === "error")
  const reviews = issues.filter((entry) => entry.severity === "review")
  if (blocking.length > 0)
    return fail(
      "review-queue",
      `${blocking.length} blocking normalization issues`,
      blocking.map((entry) => entry.message),
    )
  if (reviews.length > 0)
    return warning(
      "review-queue",
      `${reviews.length} records require human review`,
      reviews.map((entry) => entry.message),
    )
  return pass("review-queue", "Normalization produced no unresolved review items")
}

async function checkRawConsumption(root: string, segments: Segment[]): Promise<GateResult> {
  const rawRoot = join(root, ".plot-tools", "raw")
  const files = (await listFilesRecursive(rawRoot)).filter((path) => extname(path) === ".json")
  const names = new Set(files.map((path) => basename(path, ".json")))
  const missing = segments.filter((segment) => !names.has(segment.id)).map((segment) => segment.id)
  const extra = [...names].filter((name) => !segments.some((segment) => segment.id === name))
  return missing.length + extra.length === 0
    ? pass("raw-consumption", "Every raw model response is consumed exactly once")
    : fail("raw-consumption", "Raw response set does not match the source segments", [
        ...missing.map((id) => `Missing ${id}`),
        ...extra.map((id) => `Unexpected ${id}`),
      ])
}

async function checkPublishedGraph(root: string, output: string): Promise<GateResult> {
  const contentRoot = join(root, output)
  if (!(await pathExists(contentRoot)))
    return warning("published-links", "Obsidian output has not been rendered yet")
  const files = (await listFilesRecursive(contentRoot)).filter((path) => extname(path) === ".md")
  const targets = new Set<string>()
  for (const file of files) {
    targets.add(basename(file, ".md"))
    targets.add(relative(contentRoot, file).split(sep).join("/").replace(/\.md$/, ""))
  }
  const details: string[] = []
  for (const file of files) {
    const content = await readUtf8(file)
    for (const match of content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
      const target = match[1]!.trim()
      if (!targets.has(target)) details.push(`${relative(contentRoot, file)} -> ${target}`)
    }
  }
  return details.length === 0
    ? pass("published-links", `All wikilinks resolve across ${files.length} pages`)
    : fail("published-links", "Rendered content contains broken wikilinks", unique(details))
}

async function writeReport(root: string, gates: GateResult[]): Promise<VerificationReport> {
  const parsed = gates.map((gate) => GateResultSchema.parse(gate))
  const report = VerificationReportSchema.parse({
    generatedAt: new Date().toISOString(),
    passed: parsed.every((gate) => gate.status !== "fail"),
    gates: parsed,
  })
  await writeJson(join(root, ".plot-tools", "verification-report.json"), report)
  return report
}

function pass(id: string, messageValue: string): GateResult {
  return { id, status: "pass", message: messageValue, details: [] }
}

function fail(id: string, messageValue: string, details: string[] = []): GateResult {
  return { id, status: "fail", message: messageValue, details }
}

function warning(id: string, messageValue: string, details: string[] = []): GateResult {
  return { id, status: "warning", message: messageValue, details }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
