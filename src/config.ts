import { cp } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parse, stringify } from "yaml"
import {
  ProjectConfigSchema,
  TaxonomySchema,
  type ProjectConfig,
  type Taxonomy,
  type TaxonomyCategory,
} from "./model.js"
import { ensureDirectory, pathExists, readUtf8, writeUtf8 } from "./files.js"

export const CONFIG_FILE = "plot-tools.yml"
export const TAXONOMY_FILE = "taxonomy.yml"
export const TAXONOMY_LOCK_FILE = "taxonomy.lock.json"

const seedCategories: TaxonomyCategory[] = [
  {
    id: "character",
    labels: { singular: "Character", plural: "Characters" },
    definition: "A named person or person-like participant with a durable narrative identity.",
    include: ["Named people", "Durable aliases", "Person-like nonhuman actors"],
    exclude: ["Unnamed crowds", "Incidental roles without stable identity"],
    tags: [],
    attributes: {
      role: { type: "string", required: false, description: "Narrative or social role." },
      occupation: { type: "string", required: false, description: "Source-stated occupation." },
    },
    relations: [],
    folder: "Characters",
    pageTemplate: "entity",
  },
  {
    id: "location",
    labels: { singular: "Location", plural: "Locations" },
    definition: "A named physical or spatial setting that recurs or matters to the narrative.",
    include: ["Named settlements", "Buildings", "Regions", "Distinct settings"],
    exclude: ["Generic rooms without narrative identity"],
    tags: [],
    attributes: {},
    relations: [],
    folder: "Locations",
    pageTemplate: "entity",
  },
  {
    id: "organization",
    labels: { singular: "Organization", plural: "Organizations" },
    definition: "A durable named group, institution, faction, family, or collective actor.",
    include: ["Institutions", "Factions", "Named families acting collectively"],
    exclude: ["Temporary groups with no stable identity"],
    tags: [],
    attributes: {},
    relations: [],
    folder: "Organizations",
    pageTemplate: "entity",
  },
  {
    id: "item",
    labels: { singular: "Item", plural: "Items" },
    definition: "A distinct named or uniquely tracked physical object.",
    include: ["Named objects", "Unique documents", "Plot-significant possessions"],
    exclude: ["Ordinary interchangeable objects"],
    tags: [],
    attributes: {
      material: { type: "string", required: false, description: "Source-stated material." },
    },
    relations: [],
    folder: "Items",
    pageTemplate: "entity",
  },
  {
    id: "event",
    labels: { singular: "Event", plural: "Events" },
    definition: "A named or independently referable occurrence involving one or more participants.",
    include: ["Named incidents", "Major meetings", "Conflicts", "Investigations"],
    exclude: ["Every routine action or plot beat"],
    tags: [],
    attributes: {},
    relations: [],
    folder: "Events",
    pageTemplate: "entity",
  },
]

export function defaultTaxonomy(profile: ProjectConfig["profile"]): Taxonomy {
  return TaxonomySchema.parse({
    schemaVersion: 1,
    categories: profile === "blank" ? [] : seedCategories,
    passageKinds: ["quote"],
    relationVocabulary: [],
  })
}

export async function initializeProject(options: {
  directory: string
  title: string
  source: string
  profile: ProjectConfig["profile"]
  recordings?: string
}): Promise<string> {
  const root = resolve(options.directory)
  if (await pathExists(join(root, CONFIG_FILE))) {
    throw new Error(`${root} is already a plot-tools project`)
  }
  await ensureDirectory(root)
  const config = ProjectConfigSchema.parse({
    schemaVersion: 1,
    title: options.title,
    language: "en",
    profile: options.profile,
    sources: [{ id: "primary", path: options.source, kind: "auto" }],
    scope: { startSegment: 1, maxSegment: null, allowInferredClaims: true },
    processing: { concurrency: 4 },
    publication: { includeExcerpts: true, maxExcerptCharacters: 280 },
    ...(options.recordings ? { recordings: options.recordings } : {}),
    output: { data: "data", obsidian: "content", site: "site" },
  })
  await writeUtf8(join(root, CONFIG_FILE), stringify(config, { lineWidth: 100 }))
  await writeUtf8(
    join(root, TAXONOMY_FILE),
    stringify(defaultTaxonomy(options.profile), { lineWidth: 100 }),
  )
  await ensureDirectory(join(root, "sources"))
  await ensureDirectory(join(root, ".plot-tools", "review"))
  const skillDirectory = join(root, ".omp", "skills", "dont-lose-the-plot")
  await ensureDirectory(skillDirectory)
  await cp(
    resolve(import.meta.dirname, "..", "templates", "omp", "dont-lose-the-plot", "SKILL.md"),
    join(skillDirectory, "SKILL.md"),
  )
  return root
}

export async function findProjectRoot(start: string): Promise<string> {
  let current = resolve(start)
  while (true) {
    if (await pathExists(join(current, CONFIG_FILE))) return current
    const parent = dirname(current)
    if (parent === current) throw new Error(`No ${CONFIG_FILE} found from ${start}`)
    current = parent
  }
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  return ProjectConfigSchema.parse(parse(await readUtf8(join(root, CONFIG_FILE))))
}

export async function loadTaxonomy(root: string): Promise<Taxonomy> {
  return TaxonomySchema.parse(parse(await readUtf8(join(root, TAXONOMY_FILE))))
}
