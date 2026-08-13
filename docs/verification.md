# Verification

Verification operates on persisted artifacts, not provider confidence. `plot-tools verify` writes `.plot-tools/verification-report.json` and exits nonzero when any gate has status `fail`.

## Gate semantics

| Gate                     | Failure condition                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema-contract`        | Any config, lock, extraction, or canonical JSONL record fails its Zod schema.                                                                |
| `source-coverage`        | A scoped segment has zero or multiple extraction records, or an extraction references an unknown segment.                                    |
| `source-order`           | Scoped ordinals are not contiguous within a source.                                                                                          |
| `taxonomy-lock`          | The stable hash of `taxonomy.yml` differs from the reviewed lock.                                                                            |
| `taxonomy-conformance`   | An entity category, entity attribute, attribute value type, required attribute, passage kind, or relation predicate is absent from the lock. |
| `evidence-exactness`     | Any entity mention, claim, relationship excerpt, or passage text is not a verbatim substring of its segment.                                 |
| `identity`               | Canonical IDs duplicate or an alias maps to multiple entities.                                                                               |
| `relationship-endpoints` | A subject/object does not resolve, or a relationship has neither entity object nor explicit literal object.                                  |
| `provenance`             | Canonical provenance references an unknown segment or mismatched source.                                                                     |
| `spoiler-boundary`       | Canonical provenance exceeds the configured scoped segment boundary.                                                                         |
| `review-queue`           | Normalization produced an error-level issue. Review-level issues are warnings.                                                               |
| `raw-consumption`        | Raw response filenames do not match the scoped segment set exactly.                                                                          |
| `published-links`        | A rendered wikilink target does not exist. Missing rendered output is a warning so canonical-only workflows remain valid.                    |

## Exactness versus interpretation

Exact evidence does not claim that the model's interpretation is correct; it proves the interpretation points to real source text. The `certainty` field distinguishes explicit, inferred, and unresolved records. Projects may prohibit inferred claims with publication policy, and additional editorial review can be layered over the canonical files.

## Failure workflow

1. Read the failed gate and details in the report.
2. Fix the earliest responsible artifact: source config, decision file, recorded/provider response, or review decision.
3. Re-run the affected stage and every downstream deterministic stage.
4. Do not edit generated Markdown to hide a canonical error; rendering will overwrite it.

## Tests

The test suite uses two corpora:

- `examples/alice-in-wonderland`: real public-domain EPUB ingestion and a successful source-evidence path.
- `test/fixtures/the-clockwork-harbor`: a synthetic fixture for custom category discovery, deterministic output, pending onboarding, fabricated evidence, and taxonomy-drift failures.

Recorded provider responses make these contracts network-free and stable in CI. They test the same schemas and provider interface used by live AI Gateway requests.
