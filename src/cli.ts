#!/usr/bin/env node
import { resolve } from "node:path"
import { Command } from "commander"
import { findProjectRoot, initializeProject } from "./config.js"
import { discoverCorpus, prepareDiscoveryWork } from "./discovery.js"
import { extractSegments, prepareExtractionWork } from "./extract.js"
import { ingestProject } from "./ingest.js"
import { normalizeExtractions } from "./normalize.js"
import { applyTaxonomyOnboarding, lockExistingTaxonomy } from "./onboarding.js"
import { renderObsidian } from "./render.js"
import { buildQuartzSite, initializeQuartzSite } from "./site.js"
import { verifyProject } from "./verify.js"

const program = new Command()
  .name("plot-tools")
  .description("Build source-grounded narrative graphs from books and other long-form stories")
  .version("0.1.0")

program
  .command("init")
  .description("Initialize a narrative graph project")
  .argument("[directory]", "project directory", ".")
  .requiredOption("--title <title>", "project title")
  .option("--source <path>", "source path", "sources/story.md")
  .option("--profile <profile>", "novel, screenplay, transcript, or blank", "novel")
  .option("--recordings <path>", "recorded responses for deterministic replay")
  .action(async (directory: string, options: InitOptions) => {
    if (!isProfile(options.profile)) throw new Error(`Unknown profile ${options.profile}`)
    const root = await initializeProject({
      directory,
      title: options.title,
      source: options.source,
      profile: options.profile,
      ...(options.recordings ? { recordings: options.recordings } : {}),
    })
    print({ root })
  })

program
  .command("ingest")
  .description("Parse configured sources into stable ordered segments")
  .action(async () => {
    const root = await projectRoot()
    const result = await ingestProject(root)
    print({ sources: result.sources.length, segments: result.segments.length })
  })

program
  .command("discover")
  .description("Validate an OMP discovery response and draft taxonomy decisions")
  .option("--response <path>", "OMP-produced discovery JSON")
  .action(async (options: { response?: string }) => {
    const root = await projectRoot()
    const result = await discoverCorpus(root, {
      ...(options.response ? { responsePath: options.response } : {}),
    })
    print({ proposals: result.proposals.length })
  })

program
  .command("onboard")
  .description("Apply reviewed taxonomy decisions and create the taxonomy lock")
  .option("--decisions <path>", "decision YAML path")
  .option("--accept-recommended", "accept the model's recommended classifications", false)
  .action(async (options: { decisions?: string; acceptRecommended: boolean }) => {
    const root = await projectRoot()
    const taxonomy = await applyTaxonomyOnboarding(root, {
      acceptRecommended: options.acceptRecommended,
      ...(options.decisions ? { decisionsPath: options.decisions } : {}),
    })
    print({ categories: taxonomy.categories.length, relations: taxonomy.relationVocabulary.length })
  })

program
  .command("lock")
  .description("Lock an already reviewed taxonomy without corpus discovery")
  .action(async () => {
    const root = await projectRoot()
    const taxonomy = await lockExistingTaxonomy(root)
    print({ categories: taxonomy.categories.length })
  })

program
  .command("extract")
  .description("Validate OMP segment responses and collect them in source order")
  .option("--responses <directory>", "directory containing one OMP response per segment")
  .action(async (options: { responses?: string }) => {
    const root = await projectRoot()
    const result = await extractSegments(root, {
      ...(options.responses ? { responsesDir: options.responses } : {}),
    })
    print({ extractions: result.length })
  })

const prepare = program
  .command("prepare")
  .description("Create self-contained work items for visible OMP agents")
prepare.command("discovery").action(async () => {
  print(await prepareDiscoveryWork(await projectRoot()))
})
prepare.command("extraction").action(async () => {
  print(await prepareExtractionWork(await projectRoot()))
})

program
  .command("normalize")
  .description("Resolve identities and produce the canonical graph")
  .action(async () => {
    const root = await projectRoot()
    const graph = await normalizeExtractions(root)
    print({
      entities: graph.entities.length,
      relationships: graph.relationships.length,
      passages: graph.passages.length,
      issues: graph.issues.length,
    })
  })

program
  .command("render")
  .description("Render the canonical graph as an Obsidian vault")
  .action(async () => {
    const root = await projectRoot()
    print(await renderObsidian(root))
  })

program
  .command("verify")
  .description("Run deterministic graph and publication gates")
  .action(async () => {
    const root = await projectRoot()
    const report = await verifyProject(root)
    print(report)
    if (!report.passed) process.exitCode = 1
  })

const site = program.command("site").description("Manage the Quartz website adapter")
site
  .command("init")
  .requiredOption("--base-url <url>", "public host and optional path, without protocol")
  .action(async (options: { baseUrl: string }) => {
    const root = await projectRoot()
    print(await initializeQuartzSite(root, options.baseUrl))
  })
site.command("build").action(async () => {
  const root = await projectRoot()
  print({ output: await buildQuartzSite(root) })
})

program
  .command("build")
  .description("Run ingestion, extraction, normalization, rendering, and verification")
  .action(async () => {
    const root = await projectRoot()
    await ingestProject(root)
    await extractSegments(root)
    await normalizeExtractions(root)
    const render = await renderObsidian(root)
    const report = await verifyProject(root)
    print({ render, verification: report })
    if (!report.passed) process.exitCode = 1
  })

interface InitOptions {
  title: string
  source: string
  profile: string
  recordings?: string
}

function isProfile(value: string): value is "novel" | "screenplay" | "transcript" | "blank" {
  return ["novel", "screenplay", "transcript", "blank"].includes(value)
}

async function projectRoot(): Promise<string> {
  return findProjectRoot(resolve(process.cwd()))
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
