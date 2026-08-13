# dont-lose-the-plot

`dont-lose-the-plot` turns long-form narrative sources into a source-grounded knowledge graph, an Obsidian vault, and a Quartz website. The CLI command is `plot-tools`.

The pipeline is designed for factual reliability rather than unconstrained wiki generation: every extracted record retains segment provenance, quoted evidence must occur verbatim in the source, taxonomy changes require review and locking, and deterministic gates block invalid publication.

## Real example: Alice's Adventures in Wonderland

The primary example uses the Project Gutenberg EPUB of Lewis Carroll's public-domain _Alice's Adventures in Wonderland_. The repository processes all twelve chapters with recorded structured responses, a canonical taxonomy, and a reproducible site configuration under [`examples/alice-in-wonderland`](examples/alice-in-wonderland/README.md).

```sh
npm ci
npm run build
cd examples/alice-in-wonderland
node ../../dist/cli.js ingest
node ../../dist/cli.js extract
node ../../dist/cli.js normalize
node ../../dist/cli.js render
node ../../dist/cli.js verify
node ../../dist/cli.js site build
```

The synthetic Clockwork Harbor text exists only under `test/fixtures/` to test discovery, custom taxonomy onboarding, deterministic rendering, and intentional failure paths. It is not the showcase example.

## Install and initialize

Requires Node.js 22 or newer and an authenticated [Oh My Pi](https://github.com/can1357/oh-my-pi) installation.

```sh
npm install -g dont-lose-the-plot
plot-tools init my-book \
  --title "My Book" \
  --source sources/book.epub \
  --profile novel
cd my-book
omp
```

Then ask OMP:

> Build this book into a source-grounded narrative graph and website.

`plot-tools init` installs a project skill at `.omp/skills/dont-lose-the-plot/SKILL.md`. OMP loads that playbook, keeps the workflow interactive, and shows its tools and extraction subagents in the terminal. Select or switch models through OMP as usual; `plot-tools` has no model SDK, provider integration, API key, or hidden inference process.

## Interactive workflow

OMP visibly orchestrates the deterministic CLI:

```text
plot-tools ingest
plot-tools prepare discovery
OMP task agent → .plot-tools/responses/discovery.json
plot-tools discover --response .plot-tools/responses/discovery.json
human taxonomy review
plot-tools onboard
plot-tools prepare extraction
OMP task agents → one response JSON per segment
plot-tools extract --responses .plot-tools/responses/extractions
plot-tools normalize
plot-tools render
plot-tools verify
plot-tools site build
```

The generated work items are self-contained: each names its output path, embeds the versioned prompt, references its JSON schema, and includes only the source text needed for that decision. `processing.concurrency` limits each visible extraction-subagent batch (default `4`, maximum `32`). The collector validates every response and restores source order regardless of subagent completion order.

For an established hand-authored taxonomy, OMP runs `plot-tools lock` instead of discovery and onboarding. A project with a `recordings` path is a deterministic replay fixture; it can run `discover`, `extract`, or `build` without AI.

### 1. Ingestion

EPUB package spine order, Markdown headings, and text chapter/scene headings become stable ordered segments. Each source and segment is hashed. Use `scope.startSegment` to skip front matter and `scope.maxSegment` to create a spoiler or processing boundary.

### 2. Corpus discovery and onboarding

Discovery samples the corpus across its full range and proposes structures the starter taxonomy cannot express. It does not silently change the schema. Every proposal is classified as a category, tag, attribute, relationship, merge, or rejection in a human-editable decision file. Accepted decisions produce `taxonomy.yml` and `taxonomy.lock.json`.

The starter ontology stays deliberately small:

- character
- location
- organization
- item
- event
- quote passages

Corpus-specific concepts, texts, creatures, rituals, powers, protocols, or other structures must earn inclusion through source evidence and reader value.

### 3. Structured extraction

Prompts and Zod schemas are versioned in the package. OMP task agents read generated work files and write schema-constrained response JSON while their progress remains visible in the terminal. Source text is delimited as untrusted data, evidence excerpts must be verbatim, and extracted taxonomy values must belong to the lock.

The deterministic collector rejects missing, malformed, mismatched, or out-of-taxonomy responses. It then writes one raw response per segment and reconciles all responses into source order before normalization.

### 4. Canonical graph

Normalization conservatively merges exact category/name or unambiguous alias matches. Collisions and conflicting attributes enter `.plot-tools/review/issues.jsonl` rather than being guessed away. Canonical JSONL artifacts include entities, claims, relationships, passages, questions, merge decisions, and provenance.

### 5. Publication

`plot-tools render` rebuilds an Obsidian-compatible vault from canonical data. It emits chapter pages, typed entity pages, passage pages, indexes, frontmatter, wikilinks, and a deterministic render manifest. `plot-tools site build` provisions a pinned Quartz v5 checkout, copies the rendered vault, builds the static site, and writes `site/public`.

## Project layout

```text
plot-tools.yml                 project, scope, publication, outputs
taxonomy.yml                   reviewed working taxonomy
taxonomy.lock.json             extraction contract and hash
sources/                       source EPUB, Markdown, or text
.omp/skills/                   interactive OMP orchestration playbook
.plot-tools/work/              self-contained agent work items and schemas
.plot-tools/responses/         OMP-produced structured responses
.plot-tools/runs/              auditable deterministic run manifests
.plot-tools/raw/               one validated response per segment
.plot-tools/review/            taxonomy decisions and review queues
data/segments.jsonl            ordered source units
data/extractions.jsonl         schema-valid collected responses
data/*.jsonl                   canonical graph artifacts
content/                       generated Obsidian vault
site/public/                   generated Quartz website
```

## Verification gates

`plot-tools verify` exits nonzero when a blocking gate fails. Current gates cover:

- canonical schema contracts
- exactly-once segment coverage and contiguous order
- taxonomy lock and extracted category/attribute/relation conformance
- exact source excerpts
- unambiguous identities and aliases
- relationship endpoints
- canonical provenance and spoiler boundary
- unresolved normalization errors
- one consumed raw response per segment
- rendered wikilink resolution

Warnings remain visible in `.plot-tools/verification-report.json` but do not fail the command. See [`docs/verification.md`](docs/verification.md) for gate semantics and [`docs/architecture.md`](docs/architecture.md) for stage contracts.

## Reproducibility and privacy

Run manifests record the response source, tool and prompt versions, taxonomy hash, input hashes, output hashes, timestamps, and failures. OMP's own session log records the actual selected models, tool calls, and subagents; the deterministic CLI does not pretend to be their provider. Generated pages never expose OMP sessions or raw responses. Excerpt publication is controlled by `publication.includeExcerpts` and `publication.maxExcerptCharacters`.

Only process and publish sources you have the right to use. Public-domain status varies by jurisdiction.

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

CI runs the same checks on Windows, macOS, and Linux with supported Node releases. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Apache-2.0. Source works retain their own rights and notices.
