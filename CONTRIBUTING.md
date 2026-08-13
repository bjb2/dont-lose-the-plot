# Contributing

## Setup

Requires Node.js 22 or newer.

```sh
npm ci
npm run check
npm test
npm run build
```

Do not require network credentials in tests. Use recorded responses at the same schema-validation boundary used for interactive OMP output.

## Change requirements

- Preserve source provenance through every stage.
- Reuse the canonical schemas and generic taxonomy model; do not add work-specific hard-coded categories.
- Treat source content and OMP responses as untrusted.
- Keep render output deterministic.
- Add or update a behavioral test when a public contract changes.
- Include exact source excerpts in fixture responses.
- Run the focused scenario, then the complete local checks above.

## Fixtures

The Alice example is the public showcase and verifies real EPUB behavior. Keep its Project Gutenberg notice and source hash intact. The Clockwork Harbor corpus is test-only and may be changed when a deterministic edge case needs coverage. Do not present synthetic fixtures as real examples.

## Pull requests

Explain the invariant changed, the failure mode prevented, and the commands used for verification. Generated `content/`, `site/`, raw responses, run manifests, and dependency checkouts must not be committed.
