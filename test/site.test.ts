import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { pathExists, readUtf8, writeUtf8 } from "../src/files.js"
import { publishQuartzOutput, validateQuartzOutput } from "../src/site.js"

const title = "Alice's Adventures in Wonderland"
const baseUrl = "bjb2.github.io/dont-lose-the-plot"

async function createQuartzOutput(): Promise<string> {
  const output = await mkdtemp(join(tmpdir(), "plot-tools-site-"))
  const head = `<meta name="og:site_name" content="${title}"><link rel="stylesheet" href="./index-deadbeef.css"><script src="./prescript-cafebabe.js"></script>`
  await writeUtf8(join(output, "index.html"), `<html><head>${head}</head></html>`)
  await writeUtf8(join(output, "entities.html"), `<html><head>${head}</head></html>`)
  await writeUtf8(join(output, "index-deadbeef.css"), "body { color: black; }")
  await writeUtf8(join(output, "prescript-cafebabe.js"), "export {}")
  return output
}

test("Quartz output validation accepts complete fingerprinted assets", async () => {
  const output = await createQuartzOutput()
  await validateQuartzOutput(output, title, baseUrl)
})

test("Quartz output validation rejects HTML that references a missing asset", async () => {
  const output = await createQuartzOutput()
  await writeUtf8(
    join(output, "entities.html"),
    `<html><head><meta name="og:site_name" content="${title}"><link rel="stylesheet" href="./index-missing.css"></head></html>`,
  )

  await assert.rejects(
    () => validateQuartzOutput(output, title, baseUrl),
    /entities\.html references missing asset \.\/index-missing\.css/,
  )
})

test("Quartz publication copies complete assets and removes stale files", async () => {
  const source = await createQuartzOutput()
  const output = await mkdtemp(join(tmpdir(), "plot-tools-published-site-"))
  await writeUtf8(
    join(output, "index.html"),
    `<html><head><link rel="stylesheet" href="./index-stale.css"></head></html>`,
  )
  await writeUtf8(join(output, "index-stale.css"), "body { color: red; }")
  await writeUtf8(join(output, "removed.html"), "<html>stale page</html>")

  await publishQuartzOutput(source, output)

  await validateQuartzOutput(output, title, baseUrl)
  assert.match(await readUtf8(join(output, "index.html")), /index-deadbeef\.css/)
  assert.equal(await pathExists(join(output, "index-stale.css")), false)
  assert.equal(await pathExists(join(output, "removed.html")), false)
})
