---
name: dont-lose-the-plot
description: Use when building or updating a source-grounded narrative graph in a project containing plot-tools.yml, including book ingestion, taxonomy discovery, parallel chapter extraction, Obsidian rendering, verification, or Quartz publication.
tags: [narrative, knowledge-graph, omp, subagents]
---

# Don't Lose the Plot

Operate the deterministic `plot-tools` pipeline from this interactive OMP session. OMP is the only AI host: use the current subscription-backed model and visible `task` subagents. Never add an API key, call an AI gateway, invoke `completion()`, or hide model work in a subprocess.

## Contract

- `plot-tools` performs parsing, schema validation, normalization, rendering, and verification. It never calls a model.
- OMP agents produce only the discovery and per-segment response JSON files.
- Exact excerpts must occur verbatim in the supplied segment. Never infer a quote.
- Taxonomy changes require the user's review before onboarding.
- Keep one extraction response per segment. The collector restores source order deterministically.
- Show progress with the `todo` tool. The user should see every extraction subagent in the TUI.

## Workflow

1. Read `plot-tools.yml`. A `recordings` path means deterministic fixture replay; its absence means OMP must generate the responses interactively.
2. Run `plot-tools ingest`.
3. For an interactive project, run `plot-tools prepare discovery`. Read the returned work-file path.
4. Spawn one `task` agent to read that complete work file and write the requested discovery JSON. Its acceptance criteria are: valid JSON, exact output path, and schema conformance. Tell it to skip tests, formatting, and unrelated files.
5. Run `plot-tools discover --response <returned-response-path>`.
6. Read `.plot-tools/review/taxonomy-decisions.yml`. Present every proposal and recommendation to the user. Apply the user's decisions, then run `plot-tools onboard`. Never use `--accept-recommended` without an explicit instruction in this conversation.
7. Run `plot-tools prepare extraction`. It returns the work directory, response directory, segment count, and configured concurrency.
8. List the work files. Dispatch one visible `task` agent per segment, in batches no larger than the returned concurrency. Each task must:
   - read exactly its assigned Markdown work file and referenced JSON schema;
   - write exactly the response path named in that work file;
   - return schema-valid JSON without Markdown fences;
   - copy evidence excerpts exactly from the supplied source text;
   - skip tests, formatting, and all unrelated files.
9. After every segment task completes, run `plot-tools extract --responses <returned-response-directory>`.
10. Run `plot-tools normalize`. If it reports review issues, inspect `.plot-tools/review/issues.jsonl`; resolve source ambiguities with the user instead of guessing.
11. Run `plot-tools render` and `plot-tools verify`. Do not proceed past a failing verification gate.
12. If `.plot-tools/site.json` exists, run `plot-tools site build`. Otherwise ask for the intended GitHub Pages base URL before running `plot-tools site init`.
13. Browser-check the generated site when publication is part of the request.

## Recorded projects

Projects with a `recordings` path are deterministic replay fixtures. Run `discover` and `extract` without response arguments; no AI is involved. Do not regenerate recordings unless the user explicitly asks.

## Failure modes

- `No OMP response supplied`: run the corresponding `plot-tools prepare` command and complete its work in visible subagents.
- Schema rejection: return the failing response to the same segment agent with the validator error. Do not weaken the schema.
- Taxonomy-lock mismatch: review and lock the taxonomy; never bypass the hash check.
- Fabricated evidence: return the record to the segment agent and require an exact source substring.
- Missing segment response: resume only the missing work item; do not rerun completed segments.
