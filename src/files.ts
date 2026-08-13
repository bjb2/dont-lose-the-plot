import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import type { z } from "zod"

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function readUtf8(path: string): Promise<string> {
  return readFile(path, "utf8")
}

export async function writeUtf8(path: string, content: string): Promise<void> {
  await ensureDirectory(dirname(path))
  await writeFile(path, content, "utf8")
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeUtf8(path, `${stableStringify(value, 2)}\n`)
}

export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readUtf8(path)))
}

export async function writeJsonLines(path: string, records: readonly unknown[]): Promise<void> {
  const content = records.map((record) => stableStringify(record)).join("\n")
  await writeUtf8(path, content.length === 0 ? "" : `${content}\n`)
}

export async function readJsonLines<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const content = await readUtf8(path)
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => schema.parse(JSON.parse(line)))
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

export function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(sortValue(value), null, space)
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    )
  }
  return value
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return slug || "untitled"
}

export function normalizeComparableText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+/g, " ")
    .trim()
}

export async function emptyDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
  await ensureDirectory(path)
}

export async function listFilesRecursive(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return []
  const output: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) await visit(fullPath)
      else if (entry.isFile()) output.push(fullPath)
    }
  }
  await visit(root)
  return output
}

export function resolveInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(root, candidate)
  const relativePath = relative(resolvedRoot, resolvedCandidate)
  if (
    relativePath.startsWith("..") ||
    (resolve(resolvedCandidate) === resolvedRoot && candidate.includes(".."))
  ) {
    throw new Error(`Path escapes project root: ${candidate}`)
  }
  return resolvedCandidate
}
