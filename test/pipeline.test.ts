import assert from "node:assert/strict"
import { cp, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { initializeProject } from "../src/config.js"
import { analyzeTaxonomyPilot, prepareTaxonomyPilot } from "../src/pilot.js"
import { extractSegments, prepareExtractionWork } from "../src/extract.js"
import { readUtf8, writeJson, writeJsonLines, writeUtf8 } from "../src/files.js"
import { ingestProject } from "../src/ingest.js"
import { normalizeExtractions } from "../src/normalize.js"
import { applyTaxonomyOnboarding } from "../src/onboarding.js"
import { renderObsidian } from "../src/render.js"
import { verifyProject } from "../src/verify.js"

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const exampleRoot = join(repositoryRoot, "test", "fixtures", "the-clockwork-harbor")
const aliceExampleRoot = join(repositoryRoot, "examples", "alice-in-wonderland")
const commonSenseExampleRoot = join(repositoryRoot, "examples", "common-sense")

async function createOmpProject(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "plot-tools-omp-"))
  const root = join(parent, "project")
  await initializeProject({
    directory: root,
    title: "The Clockwork Harbor",
    source: "sources/story.md",
    profile: "novel",
  })
  await cp(join(exampleRoot, "sources"), join(root, "sources"), { recursive: true })
  return root
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

async function createCommonSenseProject(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "plot-tools-common-sense-"))
  const root = join(parent, "project")
  await initializeProject({
    directory: root,
    title: "Common Sense",
    source: "sources/common-sense.epub",
    profile: "blank",
  })
  await cp(join(commonSenseExampleRoot, "sources"), join(root, "sources"), { recursive: true })
  const configPath = join(root, "plot-tools.yml")
  const config = parseYaml(await readUtf8(configPath)) as {
    scope: { startSegment: number; maxSegment: number | null }
  }
  config.scope.startSegment = 4
  config.scope.maxSegment = 6
  await writeUtf8(configPath, stringifyYaml(config))
  return root
}

async function prepareThroughOnboarding(root: string): Promise<void> {
  await ingestProject(root)
  await analyzeTaxonomyPilot(root)
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

test("OMP work items collect in source order", async () => {
  const root = await createProject()
  await prepareThroughOnboarding(root)
  const prepared = await prepareExtractionWork(root)
  const recordings = JSON.parse(await readUtf8(join(root, "recordings.json"))) as {
    responses: Record<string, unknown>
  }
  const segmentIds = [
    "primary-0001-a63e726871",
    "primary-0002-7b1eb4be42",
    "primary-0003-865df2fca8",
  ]
  for (const segmentId of [...segmentIds].reverse()) {
    await writeJson(
      join(prepared.responses, `${segmentId}.json`),
      recordings.responses[`extract:${segmentId}`],
    )
  }
  const configPath = join(root, "plot-tools.yml")
  const config = parseYaml(await readUtf8(configPath)) as { recordings?: string }
  delete config.recordings
  await writeUtf8(configPath, stringifyYaml(config))

  const extractions = await extractSegments(root, { responsesDir: prepared.responses })

  assert.equal(prepared.segments, 3)
  assert.equal(prepared.concurrency, 4)
  assert.deepEqual(
    extractions.map((extraction) => extraction.segmentId),
    segmentIds,
  )
})

test("new projects scaffold the interactive OMP skill", async () => {
  const root = await createOmpProject()
  const config = parseYaml(await readUtf8(join(root, "plot-tools.yml"))) as {
    recordings?: string
  }
  const skill = await readUtf8(join(root, ".omp", "skills", "dont-lose-the-plot", "SKILL.md"))

  assert.equal(config.recordings, undefined)
  assert.match(skill, /visible `task` subagents/)
  assert.match(skill, /plot-tools prepare pilot/)
  assert.match(skill, /plot-tools prepare extraction/)
})

test("taxonomy pilot blocks full extraction until review", async () => {
  const root = await createProject()
  await ingestProject(root)
  const preparedPilot = await prepareTaxonomyPilot(root)

  assert.equal(preparedPilot.segments.length, 3)
  await assert.rejects(() => prepareExtractionWork(root), /Taxonomy pilot review is incomplete/)

  await analyzeTaxonomyPilot(root)
  const questions = JSON.parse(
    await readUtf8(join(root, ".plot-tools", "review", "taxonomy-questions.json")),
  ) as {
    checkpoint: string
    proposalQuestions: unknown[]
  }
  assert.equal(questions.checkpoint, "before-full-extraction")
  assert.ok(questions.proposalQuestions.length > 0)
  await assert.rejects(() => prepareExtractionWork(root), /Taxonomy pilot review is incomplete/)

  await applyTaxonomyOnboarding(root, { acceptRecommended: true })
  const preparedExtraction = await prepareExtractionWork(root)
  assert.equal(preparedExtraction.segments, 3)
})

test("Common Sense EPUB splits one spine document into pilot sections", async () => {
  const root = await createCommonSenseProject()
  const ingestion = await ingestProject(root)
  const pilot = await prepareTaxonomyPilot(root)
  const work = await readUtf8(pilot.work)

  assert.equal(ingestion.segments.length, 6)
  assert.equal(ingestion.segments[0]?.title, "INTRODUCTION.")
  assert.equal(ingestion.segments[5]?.title, "APPENDIX.")
  assert.deepEqual(
    pilot.segments.map((segment) => segment.ordinal),
    [1, 2, 3, 4, 5, 6],
  )
  assert.match(work, /\[\.\.\. middle sample \.\.\.\]/)
  assert.match(work, /\[\.\.\. ending sample \.\.\.\]/)
})

test("public-domain Alice EPUB builds with exact source evidence", async () => {
  const root = await createAliceProject()
  const ingestion = await ingestProject(root)
  const pilot = await prepareTaxonomyPilot(root)
  await analyzeTaxonomyPilot(root)
  await applyTaxonomyOnboarding(root, { acceptRecommended: true })
  await extractSegments(root)
  const graph = await normalizeExtractions(root)
  await renderObsidian(root)
  const report = await verifyProject(root)

  assert.equal(ingestion.segments.length, 12)
  assert.equal(ingestion.segments[0]?.title, "CHAPTER I. Down the Rabbit-Hole")
  assert.equal(ingestion.segments[11]?.title, "CHAPTER XII. Alice’s Evidence")
  assert.deepEqual(
    pilot.segments.map((segment) => segment.ordinal),
    [1, 3, 5, 8, 10, 12],
  )
  const entityIds = new Set(graph.entities.map((entity) => entity.id))
  assert.ok(entityIds.has("character-alice"))
  assert.ok(entityIds.has("character-white-rabbit"))
  assert.ok(entityIds.has("character-queen-of-hearts"))
  assert.ok(entityIds.has("character-mock-turtle"))
  const croquet = graph.entities.filter(
    (entity) => entity.category === "game" && entity.canonicalName.toLowerCase() === "croquet",
  )
  assert.equal(croquet.length, 1)
  assert.equal(croquet[0]?.canonicalName, "Croquet")
  assert.equal(graph.relationships.length, 60)
  assert.equal(graph.passages.length, 34)
  assert.equal(
    report.passed,
    true,
    report.gates
      .filter((gate) => gate.status === "fail")
      .map((gate) => `${gate.id}: ${gate.details.join("; ")}`)
      .join("\n"),
  )
})

test("accepted taxonomy onboarding is idempotent", async () => {
  const root = await createProject()
  await ingestProject(root)
  await analyzeTaxonomyPilot(root)
  const first = await applyTaxonomyOnboarding(root, { acceptRecommended: true })
  const second = await applyTaxonomyOnboarding(root, { acceptRecommended: true })

  assert.deepEqual(second, first)
})

test("onboarding refuses unresolved taxonomy decisions", async () => {
  const root = await createProject()
  await ingestProject(root)
  await analyzeTaxonomyPilot(root)
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
