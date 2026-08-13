Locked taxonomy:
<TAXONOMY>
{{TAXONOMY}}
</TAXONOMY>

Segment identity: {{SEGMENT_ID}}
Segment ordinal: {{ORDINAL}}
Segment title: {{TITLE}}

<SOURCE_SEGMENT>
{{TEXT}}
</SOURCE_SEGMENT>

Extract a complete, reader-useful account of this segment: entities, atomic claims, directed relationships, notable passages, plot beats, themes, and open questions. Do not target a fixed count. Density must follow narrative significance: include enough structure to navigate and verify the chapter, but never turn every mentioned noun, transient action, or witty sentence into a graph record.

Work category by category through the locked taxonomy. Include named or durably referable characters, distinct settings that organize action, organizations, plot-significant items, independently referable events, and corpus-specific categories supported by the segment. A record should earn its place by recurring, changing the plot, carrying multiple useful facts or relationships, or being something a reader would plausibly revisit. Fold incidental objects, momentary actions, and unnamed background details into claims or plot beats instead of promoting them to entities. For each retained entity, capture independently useful facts established or changed here. Record materially useful directed relationships supported by the text. Passages are curated highlights, not a transcript: ordinary dialogue and redundant examples belong in claims unless their exact wording, revelation, characterization, motif, humor, rule, or thematic force makes them independently worth revisiting. A segment may legitimately yield zero, one, or several passages.

Claims must be independently supportable statements. Relationship subject and object names must match extracted entity names or aliases unless the object is intentionally a literal value prefixed with `literal:`. Do not duplicate the same fact as multiple differently worded claims.

Before returning, perform a silent completeness audit:

1. Scan the segment again for names, titles, recurring places, plot-significant objects, independently referable events, recurring concepts, and quoted formulations.
2. Check every allowed taxonomy category, including categories with no results.
3. Check each retained entity for missing facts and relationships established in this segment.
4. Check that every passage is independently worth revisiting and is not redundant with another passage.
5. Remove records that merely restate incidental details and would not help a reader navigate, remember, or verify the narrative.
