import { join } from "node:path"
import { format } from "prettier"
import { toJSONSchema } from "zod"
import {
  CanonicalClaimSchema,
  CanonicalEntitySchema,
  CanonicalPassageSchema,
  CanonicalRelationshipSchema,
  DiscoveryResultSchema,
  ProjectConfigSchema,
  SegmentExtractionSchema,
  SegmentSchema,
  TaxonomySchema,
} from "../src/model.js"
import { stableStringify, writeUtf8 } from "../src/files.js"

const schemas = {
  "project-config": ProjectConfigSchema,
  taxonomy: TaxonomySchema,
  segment: SegmentSchema,
  discovery: DiscoveryResultSchema,
  extraction: SegmentExtractionSchema,
  entity: CanonicalEntitySchema,
  claim: CanonicalClaimSchema,
  relationship: CanonicalRelationshipSchema,
  passage: CanonicalPassageSchema,
}

for (const [name, schema] of Object.entries(schemas)) {
  const value = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://dont-lose-the-plot.dev/schemas/${name}.schema.json`,
    ...toJSONSchema(schema),
  }
  const output = await format(stableStringify(value), {
    parser: "json",
    printWidth: 100,
    trailingComma: "all",
  })
  await writeUtf8(join(import.meta.dirname, "..", "schemas", `${name}.schema.json`), output)
}
