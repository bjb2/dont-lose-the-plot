import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { strToU8, zipSync } from "fflate"
import { initializeProject } from "../src/config.js"
import { ingestProject } from "../src/ingest.js"

test("EPUB ingestion follows package spine order", async () => {
  const parent = await mkdtemp(join(tmpdir(), "plot-tools-epub-"))
  const root = join(parent, "project")
  await initializeProject({
    directory: root,
    title: "Fixture EPUB",
    source: "sources/book.epub",
    profile: "novel",
    recordings: "recordings.json",
  })
  const archive = zipSync({
    "META-INF/container.xml": strToU8(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>',
    ),
    "OEBPS/package.opf": strToU8(
      '<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Spine Order</dc:title></metadata><manifest><item id="second" href="second.xhtml" media-type="application/xhtml+xml"/><item id="first" href="first.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>',
    ),
    "OEBPS/first.xhtml": strToU8(
      "<html><body><h1>First</h1><p>The first chapter has enough substantive fixture text to pass the ingestion threshold.</p></body></html>",
    ),
    "OEBPS/second.xhtml": strToU8(
      "<html><body><h1>Second</h1><p>The second chapter follows the first even though the manifest lists it earlier.</p></body></html>",
    ),
  })
  await writeFile(join(root, "sources", "book.epub"), archive)

  const result = await ingestProject(root)

  assert.equal(result.sources[0]?.title, "Spine Order")
  assert.deepEqual(
    result.segments.map((segment) => segment.title),
    ["First", "Second"],
  )
  assert.deepEqual(
    result.segments.map((segment) => segment.ordinal),
    [1, 2],
  )
})
