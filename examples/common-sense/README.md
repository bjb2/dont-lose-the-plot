# Common Sense taxonomy-pilot example

This example exercises the pre-extraction checkpoint with Thomas Paine's public-domain political pamphlet _Common Sense_. It uses the supplied Project Gutenberg EPUB and a blank starting taxonomy so the pilot must identify nonfiction-specific graph structure before full extraction.

## Source and scope

- Title: _Common Sense_
- Author: Thomas Paine
- Project Gutenberg eBook: [#147](https://www.gutenberg.org/ebooks/147)
- EPUB update: October 29, 2024
- Input file: `sources/common-sense.epub`

The EPUB places most of the pamphlet in one spine document. Ingestion splits that document at substantive level-one and level-two headings, then `scope.startSegment: 4` and `scope.maxSegment: 6` select the introduction, four main sections, and appendix while excluding Gutenberg front matter, notes, and license text.

## Pilot result

The six-section pilot proposed four evidence-backed categories:

- polity
- political system
- institution
- political concept

The reviewed checkpoint accepted those categories, eight relation predicates, and the `argument`, `proposal`, `rebuttal`, and `maxim` passage kinds. `.plot-tools/review/taxonomy-questions.json` is the exact compact checkpoint surfaced before extraction. Full extraction preparation then creates six work items, including all pilot sections, under the locked taxonomy.

## Reproduce the checkpoint

```sh
npm ci
npm run build
cd examples/common-sense
node ../../dist/cli.js ingest
node ../../dist/cli.js prepare pilot
# An OMP task writes .plot-tools/responses/taxonomy-pilot.json
node ../../dist/cli.js pilot --response .plot-tools/responses/taxonomy-pilot.json
# Review .plot-tools/review/taxonomy-questions.json, then apply the answers
node ../../dist/cli.js onboard --accept-recommended
node ../../dist/cli.js prepare extraction
```

`--accept-recommended` above reproduces the decisions already captured for this example. Interactive projects must use the OMP checkpoint and may not accept recommendations without the user's explicit instruction.
