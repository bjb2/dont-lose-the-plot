import { execFile } from "node:child_process"
import { cp, rm } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { z } from "zod"
import { loadProjectConfig } from "./config.js"
import {
  ensureDirectory,
  listFilesRecursive,
  pathExists,
  readJson,
  readUtf8,
  writeJson,
  writeUtf8,
} from "./files.js"

const execute = promisify(execFile)

const SiteConfigSchema = z.object({
  schemaVersion: z.literal(1),
  baseUrl: z.string().min(1),
  quartzBranch: z.string().min(1),
})

export async function initializeQuartzSite(
  root: string,
  baseUrl: string,
): Promise<z.infer<typeof SiteConfigSchema>> {
  const siteConfig = SiteConfigSchema.parse({
    schemaVersion: 1,
    baseUrl: baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    quartzBranch: "v5",
  })
  await writeJson(join(root, ".plot-tools", "site.json"), siteConfig)
  await writeUtf8(join(root, ".github", "workflows", "pages.yml"), pagesWorkflow())
  return siteConfig
}

export async function buildQuartzSite(root: string): Promise<string> {
  const config = await loadProjectConfig(root)
  const siteConfig = await readJson(join(root, ".plot-tools", "site.json"), SiteConfigSchema)
  const checkout = join(root, ".plot-tools", "quartz")
  if (!(await pathExists(join(checkout, "package.json")))) {
    await execute(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        siteConfig.quartzBranch,
        "https://github.com/jackyzha0/quartz.git",
        checkout,
      ],
      { cwd: root, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
    )
  }
  if (!(await pathExists(join(checkout, "node_modules")))) {
    await runPackageCommand("npm", ["ci"], checkout)
  }
  const contentRoot = resolve(root, config.output.obsidian)
  await runQuartzCommand(
    [
      "create",
      "--template",
      "obsidian",
      "--strategy",
      "copy",
      "--source",
      contentRoot,
      "--baseUrl",
      siteConfig.baseUrl,
    ],
    checkout,
  )
  await applyQuartzTheme(checkout, config.title)
  await runQuartzCommand(["plugin", "install", "--from-config"], checkout)
  await ensureDefaultQuartzTheme(checkout)

  const output = resolve(root, config.output.site, "public")
  const buildOutput = join(root, ".plot-tools", `quartz-public-${process.pid}-${Date.now()}`)
  try {
    await runQuartzBuild(checkout, buildOutput)
    await validateQuartzOutput(buildOutput, config.title, siteConfig.baseUrl)
    await publishQuartzOutput(buildOutput, output)
    await validateQuartzOutput(output, config.title, siteConfig.baseUrl)

    const previewOutput = localPreviewOutput(resolve(root, config.output.site), siteConfig.baseUrl)
    await publishQuartzOutput(buildOutput, previewOutput)
    await validateQuartzOutput(previewOutput, config.title, siteConfig.baseUrl)
    return output
  } finally {
    await rm(buildOutput, { recursive: true, force: true })
  }
}

type QuartzConfig = {
  configuration: {
    pageTitle: string
    pageTitleSuffix: string
    analytics: unknown
    theme: unknown
  }
  plugins: Array<{
    source: string
    enabled?: boolean
    options?: unknown
  }>
}

async function applyQuartzTheme(checkout: string, projectTitle: string): Promise<void> {
  const configPath = join(checkout, "quartz.config.yaml")
  const quartzConfig = parseYaml(await readUtf8(configPath)) as QuartzConfig
  quartzConfig.configuration.pageTitle = projectTitle
  quartzConfig.configuration.pageTitleSuffix = " · Narrative archive"
  quartzConfig.configuration.analytics = null
  quartzConfig.configuration.theme = {
    fontOrigin: "googleFonts",
    cdnCaching: true,
    typography: {
      header: "Schibsted Grotesk",
      body: "Source Serif 4",
      code: "IBM Plex Mono",
    },
    colors: {
      lightMode: {
        light: "#f6f1e6",
        lightgray: "#e6dcc8",
        gray: "#9a8d78",
        darkgray: "#4d463c",
        dark: "#201d19",
        secondary: "#6f2b31",
        tertiary: "#9b6a3c",
        highlight: "rgba(111, 43, 49, 0.12)",
        textHighlight: "#d9b56d66",
      },
      darkMode: {
        light: "#171411",
        lightgray: "#302923",
        gray: "#74685a",
        darkgray: "#d5c7b1",
        dark: "#f1e8da",
        secondary: "#d08b92",
        tertiary: "#d4a36e",
        highlight: "rgba(208, 139, 146, 0.14)",
        textHighlight: "#a8783266",
      },
    },
  }

  const createdModifiedDate = quartzConfig.plugins.find(
    (plugin) => plugin.source === "@quartz-community/created-modified-date",
  )
  if (createdModifiedDate) {
    createdModifiedDate.enabled = false
  }

  const footer = quartzConfig.plugins.find((plugin) => plugin.source === "@quartz-community/footer")
  if (footer) {
    footer.options = {
      links: {
        "Plot tools": "https://github.com/bjb2/dont-lose-the-plot",
      },
    }
  }

  await writeUtf8(configPath, stringifyYaml(quartzConfig))
  await cp(
    resolve(import.meta.dirname, "..", "templates", "quartz", "custom.scss"),
    join(checkout, "quartz", "styles", "custom.scss"),
  )
}

async function ensureDefaultQuartzTheme(checkout: string): Promise<void> {
  const packagePath = join(checkout, "node_modules", "@quartz-themes", "default", "package.json")
  if (await pathExists(packagePath)) return
  await runPackageCommand(
    "npm",
    ["install", "--no-save", "--ignore-scripts", "@quartz-themes/default@1.0.1"],
    checkout,
  )
}

async function runPackageCommand(command: "npm", args: string[], cwd: string): Promise<void> {
  const executable = process.platform === "win32" ? `${command}.cmd` : command
  await execute(executable, args, {
    cwd,
    windowsHide: true,
    shell: process.platform === "win32",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  })
}

async function runQuartzCommand(args: string[], checkout: string): Promise<void> {
  await execute(process.execPath, [join(checkout, "quartz", "bootstrap-cli.mjs"), ...args], {
    cwd: checkout,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  })
}

async function runQuartzBuild(checkout: string, output: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await runQuartzCommand(["build", "--output", output], checkout)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const transientWindowsLock =
        process.platform === "win32" && /\b(?:EBUSY|ENOTEMPTY)\b/.test(message)
      if (!transientWindowsLock || attempt === 3) throw error
      await delay(250)
    }
  }
}

export function localPreviewOutput(siteRoot: string, baseUrl: string): string {
  const basePath = new URL(`https://${baseUrl}`).pathname
    .split("/")
    .filter((segment) => segment.length > 0)
  return join(siteRoot, "serve", ...basePath)
}

export async function publishQuartzOutput(source: string, output: string): Promise<void> {
  await ensureDirectory(output)
  const sourceFiles = await listFilesRecursive(source)
  const orderedFiles = sourceFiles.toSorted(
    (left, right) => Number(left.endsWith(".html")) - Number(right.endsWith(".html")),
  )
  const expectedFiles = new Set(sourceFiles.map((file) => relative(source, file)))

  for (const sourceFile of orderedFiles) {
    const destination = join(output, relative(source, sourceFile))
    await ensureDirectory(dirname(destination))
    await cp(sourceFile, destination, { force: true })
  }

  const staleFiles = (await listFilesRecursive(output))
    .filter((file) => !expectedFiles.has(relative(output, file)))
    .toSorted((left, right) => Number(!left.endsWith(".html")) - Number(!right.endsWith(".html")))
  for (const staleFile of staleFiles) {
    await rm(staleFile, { force: true })
  }
}

export async function validateQuartzOutput(
  output: string,
  projectTitle: string,
  baseUrl: string,
): Promise<void> {
  const files = await listFilesRecursive(output)
  const htmlFiles = files.filter((file) => file.endsWith(".html"))
  if (htmlFiles.length === 0) {
    throw new Error(`Quartz build completed without HTML pages in ${output}`)
  }
  const expectedPages = ["index.html", "entities.html"]
  for (const page of expectedPages) {
    const pagePath = join(output, page)
    if (!(await pathExists(pagePath))) {
      throw new Error(`Quartz build completed without required page ${page}`)
    }
    const html = await readUtf8(pagePath)
    if (!html.includes(`content="${escapeHtmlAttribute(projectTitle)}"`)) {
      throw new Error(`Quartz page ${page} does not identify the site as ${projectTitle}`)
    }
  }

  const basePath = new URL(`https://${baseUrl}`).pathname.replace(/\/$/, "")
  for (const htmlFile of htmlFiles) {
    const html = await readUtf8(htmlFile)
    for (const reference of assetReferences(html)) {
      const assetPath = resolveAssetPath(output, htmlFile, reference, basePath)
      if (!(await pathExists(assetPath))) {
        throw new Error(
          `Quartz page ${relative(output, htmlFile)} references missing asset ${reference}`,
        )
      }
    }
  }
}

function assetReferences(html: string): string[] {
  return [...html.matchAll(/\b(?:href|src)=["']([^"'#?]+?\.(?:css|js))(?:[?#][^"']*)?["']/gi)]
    .map((match) => match[1]!)
    .filter((reference) => !/^(?:[a-z]+:)?\/\//i.test(reference))
}

function resolveAssetPath(
  output: string,
  htmlFile: string,
  reference: string,
  basePath: string,
): string {
  if (reference.startsWith("/")) {
    const withoutBase =
      basePath && (reference === basePath || reference.startsWith(`${basePath}/`))
        ? reference.slice(basePath.length)
        : reference
    return resolve(output, withoutBase.replace(/^\/+/, ""))
  }
  return resolve(dirname(htmlFile), reference)
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve: resolveDelay } = Promise.withResolvers<void>()
  setTimeout(resolveDelay, milliseconds)
  return promise
}

function pagesWorkflow(): string {
  return `name: Deploy narrative graph\n\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\n\npermissions:\n  contents: read\n  pages: write\n  id-token: write\n\nconcurrency:\n  group: pages\n  cancel-in-progress: false\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n      - uses: actions/setup-node@v6\n        with:\n          node-version: 24\n          cache: npm\n      - run: npm ci\n      - run: npm run build\n      - run: node dist/cli.js render\n      - run: node dist/cli.js site build\n      - uses: actions/upload-pages-artifact@v4\n        with:\n          path: site/public\n  deploy:\n    needs: build\n    environment:\n      name: github-pages\n      url: \${{ steps.deployment.outputs.page_url }}\n    runs-on: ubuntu-latest\n    steps:\n      - id: deployment\n        uses: actions/deploy-pages@v4\n`
}
