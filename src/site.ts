import { execFile } from "node:child_process"
import { cp } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { loadProjectConfig } from "./config.js"
import { emptyDirectory, pathExists, readJson, writeJson, writeUtf8 } from "./files.js"

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
  await runPackageCommand(
    "npx",
    [
      "quartz",
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
  await runPackageCommand("npx", ["quartz", "plugin", "install", "--from-config"], checkout)
  await runPackageCommand("npx", ["quartz", "build"], checkout)

  const output = resolve(root, config.output.site, "public")
  await emptyDirectory(output)
  await cp(join(checkout, "public"), output, { recursive: true })
  return output
}

async function runPackageCommand(
  command: "npm" | "npx",
  args: string[],
  cwd: string,
): Promise<void> {
  const executable = process.platform === "win32" ? `${command}.cmd` : command
  await execute(executable, args, {
    cwd,
    windowsHide: true,
    shell: process.platform === "win32",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  })
}

function pagesWorkflow(): string {
  return `name: Deploy narrative graph\n\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\n\npermissions:\n  contents: read\n  pages: write\n  id-token: write\n\nconcurrency:\n  group: pages\n  cancel-in-progress: false\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n      - uses: actions/setup-node@v6\n        with:\n          node-version: 24\n          cache: npm\n      - run: npm ci\n      - run: npm run build\n      - run: node dist/cli.js render\n      - run: node dist/cli.js site build\n      - uses: actions/upload-pages-artifact@v4\n        with:\n          path: site/public\n  deploy:\n    needs: build\n    environment:\n      name: github-pages\n      url: \${{ steps.deployment.outputs.page_url }}\n    runs-on: ubuntu-latest\n    steps:\n      - id: deployment\n        uses: actions/deploy-pages@v4\n`
}
