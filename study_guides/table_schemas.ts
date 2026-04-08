/**
 * Table schema definitions for maximal study guide rendering/validation.
 *
 * Used by: `render_maximal_html.ts` and tests to enforce required table headers.
 *
 * Key exports:
 * - `TableSchemaId`/`TableSchema`
 * - `TABLE_SCHEMAS` and lookup helpers.
 *
 * Assumptions:
 * - Header matching is case-sensitive unless normalized by callers.
 */
export type TableSchemaId = "rapid-approach-summary" | "treatments-management";

/**
 * Schema describing required headers and alias mappings for a table.
 */
export type TableSchema = {
  id: TableSchemaId;
  requiredHeaders: string[];
  allowedHeaderAliases?: Record<string, string[]>;
  mustExistInMaximal: boolean;
};

/**
 * Canonical table schema map keyed by schema id.
 */
export const TABLE_SCHEMAS: Record<TableSchemaId, TableSchema> = {
  "rapid-approach-summary": {
    id: "rapid-approach-summary",
    requiredHeaders: ["Clue", "Think of", "Why (discriminator)", "Confirm/Monitor", "Treat/Next step"],
    allowedHeaderAliases: {
      "Why (discriminator)": ["Why", "Discriminator", "Key discriminator", "Distinguishing feature"],
      "Confirm/Monitor": ["Confirm", "Confirmatory test", "Monitor", "Monitoring"],
      "Treat/Next step": ["Treat", "Treatment", "Management", "Next step", "Next"],
    },
    mustExistInMaximal: true,
  },
  "treatments-management": {
    id: "treatments-management",
    requiredHeaders: ["Drug/Class", "Mechanism", "Toxicity", "Monitoring", "Pearls"],
    allowedHeaderAliases: {
      "Drug/Class": ["Drug", "Drug class", "Class"],
      "Mechanism": ["MOA", "Mode of action", "Mechanism of action"],
      "Toxicity": ["Signature toxicity", "Key toxicity", "Adverse effects", "Adverse events"],
      "Monitoring": ["Monitor", "Monitoring", "Monitor/Interactions", "Monitor & interactions"],
      "Pearls": ["Pearl", "Key pearls", "PK", "PK pearls", "Clinical pearls"],
    },
    mustExistInMaximal: true,
  },
};

/**
 * List of schema definitions (useful for iteration/validation).
 */
export const TABLE_SCHEMA_LIST: TableSchema[] = Object.values(TABLE_SCHEMAS);

/**
 * Lookup a schema by id.
 *
 * @param id - Schema identifier.
 * @returns Matching schema or null if unknown.
 */
export function getTableSchema(id: string): TableSchema | null {
  return (TABLE_SCHEMAS as Record<string, TableSchema | undefined>)[id] || null;
}
