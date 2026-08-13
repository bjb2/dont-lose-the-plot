import { z } from "zod"

export const CertaintySchema = z.enum(["explicit", "inferred", "unresolved"])
export const SalienceSchema = z.enum(["primary", "supporting", "reference"])
export const SourceKindSchema = z.enum(["auto", "epub", "markdown", "text"])

export const ProjectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  language: z.string().min(2).default("en"),
  profile: z.enum(["novel", "screenplay", "transcript", "blank"]).default("novel"),
  sources: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        path: z.string().min(1),
        kind: SourceKindSchema.default("auto"),
      }),
    )
    .min(1),
  scope: z.object({
    startSegment: z.number().int().positive().default(1),
    maxSegment: z.number().int().positive().nullable().default(null),
    allowInferredClaims: z.boolean().default(true),
  }),
  processing: z
    .object({
      concurrency: z.number().int().min(1).max(32).default(4),
    })
    .default({ concurrency: 4 }),
  publication: z.object({
    includeExcerpts: z.boolean().default(true),
    maxExcerptCharacters: z.number().int().nonnegative().default(280),
  }),
  recordings: z.string().min(1).optional(),
  output: z.object({
    data: z.string().default("data"),
    obsidian: z.string().default("content"),
    site: z.string().default("site"),
  }),
})

export const SourceRecordSchema = z.object({
  id: z.string(),
  path: z.string(),
  kind: z.enum(["epub", "markdown", "text"]),
  sha256: z.string().length(64),
  title: z.string(),
  segmentCount: z.number().int().nonnegative(),
})

export const SegmentSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  ordinal: z.number().int().positive(),
  title: z.string(),
  text: z.string(),
  sha256: z.string().length(64),
  locator: z.string(),
})

export const TaxonomyAttributeSchema = z.object({
  type: z.enum(["string", "number", "boolean", "string-list", "entity-ref", "object"]),
  required: z.boolean().default(false),
  target: z.string().optional(),
  description: z.string().optional(),
})

export const TaxonomyCategorySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  labels: z.object({ singular: z.string().min(1), plural: z.string().min(1) }),
  definition: z.string().min(1),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  attributes: z.record(z.string(), TaxonomyAttributeSchema).default({}),
  relations: z.array(z.string()).default([]),
  folder: z.string().min(1),
  pageTemplate: z.string().default("entity"),
})

export const TaxonomySchema = z.object({
  schemaVersion: z.literal(1),
  categories: z.array(TaxonomyCategorySchema),
  passageKinds: z.array(z.string()).default(["quote"]),
  relationVocabulary: z.array(z.string()).default([]),
})

export const CategoryProposalSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  labels: z.object({ singular: z.string(), plural: z.string() }),
  definition: z.string(),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  examples: z.array(
    z.object({
      name: z.string(),
      segmentId: z.string(),
      evidence: z.string(),
    }),
  ),
  sharedAttributes: z.array(
    z.object({
      id: z.string(),
      type: TaxonomyAttributeSchema.shape.type,
      description: z.string(),
    }),
  ),
  commonRelations: z.array(z.string()),
  recommendedAs: z.enum(["category", "tag", "attribute", "relationship", "ignore"]),
  mergeInto: z.string().nullable(),
  readerValue: z.string(),
  confidence: z.number().min(0).max(1),
})

export const TaxonomyPilotResultSchema = z.object({
  corpusProfile: z.object({
    genre: z.string(),
    structure: z.string(),
    namingConventions: z.array(z.string()),
    extractionRisks: z.array(z.string()),
  }),
  proposals: z.array(CategoryProposalSchema),
  proposedPassageKinds: z.array(z.string()),
  proposedRelations: z.array(z.string()),
})

export const EvidenceSchema = z.object({
  excerpt: z.string().min(1),
  supports: z.string().min(1),
})

export const ExtractedClaimSchema = z.object({
  text: z.string().min(1),
  certainty: CertaintySchema,
  excerpt: z.string().min(1),
})

export const ExtractedEntitySchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  summary: z.string().min(1),
  salience: SalienceSchema,
  certainty: CertaintySchema,
  excerpt: z.string().min(1),
  attributes: z.record(z.string(), z.unknown()).default({}),
  claims: z.array(ExtractedClaimSchema).default([]),
})

export const ExtractedRelationshipSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  certainty: CertaintySchema,
  excerpt: z.string().min(1),
})

export const ExtractedPassageSchema = z.object({
  title: z.string().min(1),
  kind: z.string().min(1),
  speaker: z.string().nullable(),
  text: z.string().min(1),
  context: z.string().min(1),
  significance: z.string().min(1),
  entities: z.array(z.string()),
  complete: z.boolean(),
  certainty: CertaintySchema,
})

export const SegmentExtractionSchema = z.object({
  segmentId: z.string(),
  summary: z.string().min(1),
  plotBeats: z.array(z.string()),
  themes: z.array(z.string()),
  entities: z.array(ExtractedEntitySchema),
  relationships: z.array(ExtractedRelationshipSchema),
  passages: z.array(ExtractedPassageSchema),
  openQuestions: z.array(z.string()),
})

export const ProvenanceSchema = z.object({
  sourceId: z.string(),
  segmentId: z.string(),
  segmentOrdinal: z.number().int().positive(),
  locator: z.string(),
  excerpt: z.string().optional(),
})

export const CanonicalClaimSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  text: z.string(),
  certainty: CertaintySchema,
  provenance: ProvenanceSchema,
})

export const CanonicalEntitySchema = z.object({
  id: z.string(),
  category: z.string(),
  canonicalName: z.string(),
  aliases: z.array(z.string()),
  summary: z.string(),
  salience: SalienceSchema,
  certainty: CertaintySchema,
  firstSeen: ProvenanceSchema,
  mentions: z.array(ProvenanceSchema),
  attributes: z.record(z.string(), z.unknown()),
})

export const CanonicalRelationshipSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  predicate: z.string(),
  objectId: z.string().nullable(),
  literalObject: z.string().nullable(),
  certainty: CertaintySchema,
  provenance: ProvenanceSchema,
})

export const CanonicalPassageSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  speakerId: z.string().nullable(),
  text: z.string(),
  context: z.string(),
  significance: z.string(),
  entityIds: z.array(z.string()),
  complete: z.boolean(),
  certainty: CertaintySchema,
  provenance: ProvenanceSchema,
})

export const OpenQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  provenance: ProvenanceSchema,
})

export const MergeDecisionSchema = z.object({
  canonicalEntityId: z.string(),
  mergedName: z.string(),
  reason: z.string(),
  automatic: z.boolean(),
})

export const IssueSchema = z.object({
  id: z.string(),
  severity: z.enum(["error", "warning", "review"]),
  code: z.string(),
  message: z.string(),
  segmentId: z.string().optional(),
  entityId: z.string().optional(),
})

export const GateResultSchema = z.object({
  id: z.string(),
  status: z.enum(["pass", "fail", "warning"]),
  message: z.string(),
  details: z.array(z.string()).default([]),
})

export const VerificationReportSchema = z.object({
  generatedAt: z.string(),
  passed: z.boolean(),
  gates: z.array(GateResultSchema),
})

export const RunManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  command: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  status: z.enum(["running", "completed", "failed"]),
  toolVersion: z.string(),
  taxonomyHash: z.string().nullable(),
  promptVersions: z.record(z.string(), z.string()),
  responseSource: z.enum(["omp", "recorded"]),
  inputHashes: z.record(z.string(), z.string()),
  outputHashes: z.record(z.string(), z.string()),
  error: z.string().nullable(),
})

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>
export type SourceRecord = z.infer<typeof SourceRecordSchema>
export type Segment = z.infer<typeof SegmentSchema>
export type Taxonomy = z.infer<typeof TaxonomySchema>
export type TaxonomyCategory = z.infer<typeof TaxonomyCategorySchema>
export type TaxonomyPilotResult = z.infer<typeof TaxonomyPilotResultSchema>
export type SegmentExtraction = z.infer<typeof SegmentExtractionSchema>
export type Provenance = z.infer<typeof ProvenanceSchema>
export type CanonicalEntity = z.infer<typeof CanonicalEntitySchema>
export type CanonicalClaim = z.infer<typeof CanonicalClaimSchema>
export type CanonicalRelationship = z.infer<typeof CanonicalRelationshipSchema>
export type CanonicalPassage = z.infer<typeof CanonicalPassageSchema>
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>
export type MergeDecision = z.infer<typeof MergeDecisionSchema>
export type Issue = z.infer<typeof IssueSchema>
export type GateResult = z.infer<typeof GateResultSchema>
export type VerificationReport = z.infer<typeof VerificationReportSchema>
export type RunManifest = z.infer<typeof RunManifestSchema>
