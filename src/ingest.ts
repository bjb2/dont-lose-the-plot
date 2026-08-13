import { readFile } from "node:fs/promises"
import { extname, join, posix, resolve } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { loadProjectConfig } from "./config.js"
import { normalizeComparableText, sha256, slugify, writeJson, writeJsonLines } from "./files.js"
import { SegmentSchema, SourceRecordSchema, type Segment, type SourceRecord } from "./model.js"

interface DraftSegment {
  title: string
  text: string
  locator: string
}

export async function ingestProject(root: string): Promise<{
  sources: SourceRecord[]
  segments: Segment[]
}> {
  const config = await loadProjectConfig(root)
  const sources: SourceRecord[] = []
  const segments: Segment[] = []

  for (const sourceConfig of config.sources) {
    const sourcePath = resolve(root, sourceConfig.path)
    const bytes = new Uint8Array(await readFile(sourcePath))
    const kind = sourceConfig.kind === "auto" ? detectKind(sourcePath) : sourceConfig.kind
    const ingested =
      kind === "epub"
        ? extractEpub(bytes, sourceConfig.path)
        : extractText(strFromU8(bytes), sourceConfig.path, kind)
    const startIndex = config.scope.startSegment - 1
    const scopedSegments = config.scope.maxSegment
      ? ingested.segments.slice(startIndex, startIndex + config.scope.maxSegment)
      : ingested.segments.slice(startIndex)
    const source = SourceRecordSchema.parse({
      id: sourceConfig.id,
      path: sourceConfig.path,
      kind,
      sha256: sha256(bytes),
      title: ingested.title,
      segmentCount: scopedSegments.length,
    })
    sources.push(source)
    for (const [index, draft] of scopedSegments.entries()) {
      const text = normalizeComparableText(draft.text)
      const contentHash = sha256(text)
      segments.push(
        SegmentSchema.parse({
          id: `${source.id}-${String(index + 1).padStart(4, "0")}-${contentHash.slice(0, 10)}`,
          sourceId: source.id,
          ordinal: index + 1,
          title: draft.title || `Segment ${index + 1}`,
          text,
          sha256: contentHash,
          locator: draft.locator,
        }),
      )
    }
  }

  const dataDirectory = join(root, config.output.data)
  await writeJson(join(root, ".plot-tools", "source-manifest.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources,
    segmentIds: segments.map((segment) => segment.id),
  })
  await writeJsonLines(join(dataDirectory, "segments.jsonl"), segments)
  return { sources, segments }
}

function detectKind(path: string): "epub" | "markdown" | "text" {
  const extension = extname(path).toLowerCase()
  if (extension === ".epub") return "epub"
  if (extension === ".md" || extension === ".markdown") return "markdown"
  if (extension === ".txt" || extension === ".text") return "text"
  throw new Error(`Cannot infer source kind from ${path}; set sources[].kind explicitly`)
}

function extractText(
  input: string,
  sourcePath: string,
  kind: "markdown" | "text",
): { title: string; segments: DraftSegment[] } {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
  const title =
    /^#\s+(.+)$/m.exec(normalized)?.[1]?.trim() ??
    /^(?:chapter|scene|part)\s+[^\n]+/im.exec(normalized)?.[0]?.trim() ??
    sourcePath
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ??
    "Source"
  const headingPattern =
    kind === "markdown"
      ? /^(#{1,2})\s+(.+)$/gm
      : /^(?:(?:chapter|scene|part|act)\s+(?:\d+|[ivxlcdm]+)(?:\s*[:—-].*)?)$/gim
  const matches = [...normalized.matchAll(headingPattern)]
  if (matches.length === 0) {
    return { title, segments: [{ title, text: normalized, locator: sourcePath }] }
  }

  const segments: DraftSegment[] = []
  for (const [index, match] of matches.entries()) {
    const start = match.index ?? 0
    const end = matches[index + 1]?.index ?? normalized.length
    const heading = (match[2] ?? match[0]).replace(/^#+\s*/, "").trim()
    const body = normalized.slice(start + match[0].length, end).trim()
    if (body.length < 20) continue
    segments.push({ title: heading, text: body, locator: `${sourcePath}#${slugify(heading)}` })
  }
  if (segments.length === 0) throw new Error(`No substantive segments found in ${sourcePath}`)
  return { title, segments }
}

function extractEpub(
  bytes: Uint8Array,
  sourcePath: string,
): { title: string; segments: DraftSegment[] } {
  const archive = unzipSync(bytes)
  const readEntry = (path: string): string => {
    const entry = archive[normalizeArchivePath(path)]
    if (!entry) throw new Error(`EPUB entry not found: ${path}`)
    return strFromU8(entry)
  }
  const container = readEntry("META-INF/container.xml")
  const opfPath = /full-path=["']([^"']+)["']/.exec(container)?.[1]
  if (!opfPath) throw new Error("EPUB container does not identify an OPF package")
  const opf = readEntry(opfPath)
  const opfDirectory = posix.dirname(normalizeArchivePath(opfPath))
  const title = decodeXml(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1] ?? "Untitled")
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>()
  for (const itemTag of opf.match(/<item\b[^>]*\/?\s*>/gi) ?? []) {
    const attributes = parseAttributes(itemTag)
    if (!attributes.id || !attributes.href) continue
    manifest.set(attributes.id, {
      href: attributes.href,
      mediaType: attributes["media-type"] ?? "",
      properties: attributes.properties ?? "",
    })
  }
  const navigationTitles = new Map<string, string>()
  const ncxItem = [...manifest.values()].find(
    (item) => item.mediaType === "application/x-dtbncx+xml",
  )
  if (ncxItem) {
    const ncx = readEntry(posix.join(opfDirectory, stripFragment(ncxItem.href)))
    for (const navPoint of ncx.match(/<navPoint\b[\s\S]*?<\/navPoint>/gi) ?? []) {
      const href = /<content\b[^>]*src=["']([^"']+)["']/.exec(navPoint)?.[1]
      const label = /<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>/.exec(navPoint)?.[1]
      if (href && label) {
        const path = normalizeArchivePath(stripFragment(href))
        if (!navigationTitles.has(path)) navigationTitles.set(path, decodeXml(label))
      }
    }
  }
  const navItem = [...manifest.values()].find((item) =>
    item.properties.split(/\s+/).includes("nav"),
  )
  if (navItem) {
    const navigation = readEntry(posix.join(opfDirectory, stripFragment(navItem.href)))
    for (const anchor of navigation.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi) ??
      []) {
      const href = /href=["']([^"']+)["']/.exec(anchor)?.[1]
      if (href) {
        const path = normalizeArchivePath(stripFragment(href))
        if (!navigationTitles.has(path)) navigationTitles.set(path, stripHtml(anchor))
      }
    }
  }

  const segments: DraftSegment[] = []
  const seen = new Set<string>()
  for (const itemRef of opf.match(/<itemref\b[^>]*\/?\s*>/gi) ?? []) {
    const idref = parseAttributes(itemRef).idref
    const item = idref ? manifest.get(idref) : undefined
    if (!item || !/xhtml|html/.test(item.mediaType)) continue
    const href = normalizeArchivePath(stripFragment(item.href))
    if (seen.has(href)) continue
    seen.add(href)
    const fullPath = posix.join(opfDirectory, href)
    const xhtml = readEntry(fullPath)
    const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml)?.[1] ?? xhtml
    const fallbackTitle =
      navigationTitles.get(href) ??
      stripHtml(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(xhtml)?.[1] ?? "") ??
      `Segment ${segments.length + 1}`
    segments.push(...splitEpubDocument(body, fallbackTitle, `${sourcePath}:${fullPath}`))
  }
  if (segments.length === 0) throw new Error("EPUB spine contains no substantive text segments")
  return { title, segments }
}

function splitEpubDocument(body: string, fallbackTitle: string, locator: string): DraftSegment[] {
  const wholeDocument = (): DraftSegment[] => {
    const text = stripHtml(body)
    return text.length < 50 ? [] : [{ title: fallbackTitle, text, locator }]
  }
  const candidates = [...body.matchAll(/<h[12]\b([^>]*)>([\s\S]*?)<\/h[12]>/gi)].map((match) => ({
    index: match.index ?? 0,
    title: stripHtml(match[2] ?? ""),
    attributes: parseAttributes(match[1] ?? ""),
  }))
  const substantive = candidates.filter((heading) => heading.title && !/^\d+$/.test(heading.title))
  const chapterHeadings = substantive.filter((heading) =>
    /^(?:chapter|part|book|act|scene)\b/i.test(heading.title),
  )
  const headings = chapterHeadings.length >= 2 ? chapterHeadings : substantive
  if (headings.length <= 1) return wholeDocument()
  const candidateTextLength = stripHtml(body.slice(headings[0]!.index)).length
  if (candidateTextLength < 50_000) return wholeDocument()

  const sections: DraftSegment[] = []
  for (const [index, heading] of headings.entries()) {
    const end = headings[index + 1]?.index ?? body.length
    const text = stripHtml(body.slice(heading.index, end))
    if (text.length < 50) continue
    const anchor = heading.attributes.id || slugify(heading.title)
    sections.push({
      title: heading.title,
      text,
      locator: `${locator}#${anchor}`,
    })
  }
  return sections.length >= 2 ? sections : wholeDocument()
}

function parseAttributes(tag: string): Record<string, string> {
  const output: Record<string, string> = {}
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*["']([^"']*)["']/g)) {
    const key = match[1]
    const value = match[2]
    if (key && value !== undefined) output[key] = decodeXml(value)
  }
  return output
}

function stripHtml(value: string): string {
  return normalizeComparableText(
    decodeXml(
      value
        .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "- ")
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, ""),
    ),
  )
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function stripFragment(path: string): string {
  return path.split("#", 1)[0] ?? path
}

function normalizeArchivePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "")
}
