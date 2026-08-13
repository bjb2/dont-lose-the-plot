import assert from "node:assert/strict"
import { cp, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { initializeProject } from "../src/config.js"
import { discoverCorpus } from "../src/discovery.js"
import { extractSegments } from "../src/extract.js"
import { readUtf8, writeJsonLines, writeUtf8 } from "../src/files.js"
import { ingestProject } from "../src/ingest.js"
import { normalizeExtractions } from "../src/normalize.js"
import { applyTaxonomyOnboarding } from "../src/onboarding.js"
import {
  RecordedProvider,
  type GenerationRequest,
  type StructuredProvider,
} from "../src/providers.js"
import { renderObsidian } from "../src/render.js"
import { verifyProject } from "../src/verify.js"

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const exampleRoot = join(repositoryRoot, "test", "fixtures", "the-clockwork-harbor")
const aliceExampleRoot = join(repositoryRoot, "examples", "alice-in-wonderland")

class TrackingProvider implements StructuredProvider {
  readonly name = "tracking-recorded"
  readonly model = null
  active = 0
  maxActive = 0

  constructor(private readonly inner: RecordedProvider) {}

  async generate<T>(request: GenerationRequest<T>): Promise<T> {
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    await delay(20)
    try {
      return await this.inner.generate(request)
    } finally {
      this.active -= 1
    }
  }
}

async function createProject(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "plot-tools-"))
  const root = join(parent, "project")
  await initializeProject({
    directory: root,
    title: "The Clockwork Harbor",
    source: "sources/story.md",
    profile: "novel",
    recordings: "recordings.json",
  })
  await cp(join(exampleRoot, "sources"), join(root, "sources"), { recursive: true })
  await cp(join(exampleRoot, "recordings.json"), join(root, "recordings.json"))
  return root
}

async function createAliceProject(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "plot-tools-alice-"))
  const root = join(parent, "project")
  await initializeProject({
    directory: root,
    title: "Alice's Adventures in Wonderland",
    source: "sources/alice-in-wonderland.epub",
    profile: "novel",
    recordings: "recordings.json",
  })
  await cp(join(aliceExampleRoot, "sources"), join(root, "sources"), { recursive: true })
  await cp(join(aliceExampleRoot, "recordings.json"), join(root, "recordings.json"))
  const configPath = join(root, "plot-tools.yml")
  const config = parseYaml(await readUtf8(configPath)) as {
    scope: { startSegment: number; maxSegment: number | null }
    processing: { concurrency: number }
  }
  config.scope.startSegment = 2
  config.scope.maxSegment = 12
  config.processing.concurrency = 6
  await writeUtf8(configPath, stringifyYaml(config))
  return root
}

async function prepareThroughOnboarding(root: string): Promise<void> {
  await ingestProject(root)
  await discoverCorpus(root)
  await applyTaxonomyOnboarding(root, { acceptRecommended: true })
}

async function prepareCanonicalGraph(root: string): Promise<void> {
  await prepareThroughOnboarding(root)
  await extractSegments(root)
  await normalizeExtractions(root)
}

test("recorded corpus builds a deterministic, verified graph", async () => {
  const root = await createProject()
  await prepareCanonicalGraph(root)
  const firstRender = await renderObsidian(root)
  const secondRender = await renderObsidian(root)
  const report = await verifyProject(root)
  const graph = await normalizeExtractions(root)
  const gold = JSON.parse(
    await readUtf8(join(repositoryRoot, "test", "gold", "the-clockwork-harbor.json")),
  ) as {
    entityIds: string[]
    segments: number
    relationships: number
    passages: number
    renderedFiles: number
  }

  assert.equal(firstRender.hash, secondRender.hash)
  assert.equal(firstRender.files, gold.renderedFiles)
  assert.deepEqual(
    graph.entities.map((entity) => entity.id),
    gold.entityIds,
  )
  assert.equal(graph.relationships.length, gold.relationships)
  assert.equal(graph.passages.length, gold.passages)
  assert.equal(report.passed, true)
  assert.equal(report.gates.find((gate) => gate.id === "evidence-exactness")?.status, "pass")
})

test("segment extraction fans out and reconciles in source order", async () => {
  const root = await createProject()
  await prepareThroughOnboarding(root)
  const provider = new TrackingProvider(new RecordedProvider(join(root, "recordings.json")))

  const extractions = await extractSegments(root, { provider })

  assert.ok(provider.maxActive > 1)
  assert.deepEqual(
    extractions.map((extraction) => extraction.segmentId),
    ["primary-0001-a63e726871", "primary-0002-7b1eb4be42", "primary-0003-865df2fca8"],
  )
})

test("public-domain Alice EPUB builds with exact source evidence", async () => {
  const root = await createAliceProject()
  const ingestion = await ingestProject(root)
  await discoverCorpus(root)
  await applyTaxonomyOnboarding(root, { acceptRecommended: true })
  await extractSegments(root)
  const graph = await normalizeExtractions(root)
  await renderObsidian(root)
  const report = await verifyProject(root)

  assert.equal(ingestion.segments.length, 12)
  assert.equal(ingestion.segments[0]?.title, "CHAPTER I. Down the Rabbit-Hole")
  assert.equal(ingestion.segments[11]?.title, "CHAPTER XII. Alice’s Evidence")
  const entityIds = new Set(graph.entities.map((entity) => entity.id))
  assert.ok(entityIds.has("character-alice"))
  assert.ok(entityIds.has("character-white-rabbit"))
  assert.ok(entityIds.has("character-queen-of-hearts"))
  assert.ok(entityIds.has("character-mock-turtle"))
  assert.equal(graph.relationships.length, 27)
  assert.equal(graph.passages.length, 12)
  assert.equal(report.passed, true)
})

test("onboarding refuses unresolved taxonomy decisions", async () => {
  const root = await createProject()
  await ingestProject(root)
  await discoverCorpus(root)
  await assert.rejects(() => applyTaxonomyOnboarding(root), /decisions remain pending/i)
})

test("verification rejects fabricated evidence", async () => {
  const root = await createProject()
  await prepareCanonicalGraph(root)
  const extractionPath = join(root, "data", "extractions.jsonl")
  const extractions = (await readUtf8(extractionPath))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const first = extractions[0] as { entities: Array<{ excerpt: string }> }
  first.entities[0]!.excerpt = "This sentence does not occur in the source."
  await writeJsonLines(extractionPath, extractions)
  const report = await verifyProject(root)

  assert.equal(report.passed, false)
  assert.equal(report.gates.find((gate) => gate.id === "evidence-exactness")?.status, "fail")
})

test("extraction rejects a taxonomy changed after locking", async () => {
  const root = await createProject()
  await prepareThroughOnboarding(root)
  const taxonomyPath = join(root, "taxonomy.yml")
  const taxonomy = parseYaml(await readUtf8(taxonomyPath)) as { relationVocabulary: string[] }
  taxonomy.relationVocabulary.push("unreviewed-relation")
  await writeUtf8(taxonomyPath, stringifyYaml(taxonomy))

  await assert.rejects(() => extractSegments(root), /differs from taxonomy\.lock\.json/)
})
