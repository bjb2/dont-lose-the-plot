import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { readJson, sha256, stableStringify, writeJson } from "./files.js"
import { RunManifestSchema, type RunManifest } from "./model.js"

const TOOL_VERSION = "0.1.0"

export async function startRun(options: {
  root: string
  command: string
  provider: string
  model: string | null
  taxonomy?: unknown
  promptVersions?: Record<string, string>
  inputHashes?: Record<string, string>
}): Promise<RunManifest> {
  const startedAt = new Date().toISOString()
  const manifest = RunManifestSchema.parse({
    schemaVersion: 1,
    runId: `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    command: options.command,
    startedAt,
    completedAt: null,
    status: "running",
    toolVersion: TOOL_VERSION,
    taxonomyHash: options.taxonomy ? sha256(stableStringify(options.taxonomy)) : null,
    promptVersions: options.promptVersions ?? {},
    provider: options.provider,
    model: options.model,
    inputHashes: options.inputHashes ?? {},
    outputHashes: {},
    error: null,
  })
  await writeJson(runPath(options.root, manifest.runId), manifest)
  return manifest
}

export async function completeRun(
  root: string,
  manifest: RunManifest,
  outputHashes: Record<string, string>,
): Promise<RunManifest> {
  const completed = RunManifestSchema.parse({
    ...manifest,
    completedAt: new Date().toISOString(),
    status: "completed",
    outputHashes,
  })
  await writeJson(runPath(root, completed.runId), completed)
  return completed
}

export async function failRun(
  root: string,
  manifest: RunManifest,
  error: unknown,
): Promise<RunManifest> {
  const failed = RunManifestSchema.parse({
    ...manifest,
    completedAt: new Date().toISOString(),
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  })
  await writeJson(runPath(root, failed.runId), failed)
  return failed
}

export async function loadRun(root: string, runId: string): Promise<RunManifest> {
  return readJson(runPath(root, runId), RunManifestSchema)
}

function runPath(root: string, runId: string): string {
  return join(root, ".plot-tools", "runs", `${runId}.json`)
}
