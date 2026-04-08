/**
 * Normalization helpers for study guide topic and token comparison.
 *
 * Used by: study guide inventory, fact registry, and validators to compare
 * headings and tokens in a consistent way.
 *
 * Key exports:
 * - `stripLeadingNumbering`, `normalizeForComparison`, `normalizeTokens`.
 *
 * Assumptions:
 * - Intended for English text; normalization is lossy by design.
 */
const STOPWORDS = new Set([
  "in",
  "of",
  "and",
  "the",
  "a",
  "an",
  "to",
  "for",
  "with",
  "on",
  "at",
  "by",
  "from",
]);

const VARIANT_MAP: Record<string, string> = {
  paediatric: "pediatric",
  pediatrics: "pediatric",
  utis: "uti",
};

/**
 * Remove leading numeric list prefixes (e.g., "1. ", "2) ").
 *
 * @param value - Raw heading or list item.
 * @returns String without leading numbering.
 */
export function stripLeadingNumbering(value: string): string {
  return (value || "").replace(/^\s*\d+[\.\)]\s*/g, "");
}

/**
 * Normalize text for fuzzy comparison by lowercasing and stripping punctuation.
 *
 * @param value - Raw text to normalize.
 * @returns Normalized comparison string.
 */
export function normalizeForComparison(value: string): string {
  const stripped = stripLeadingNumbering(value || "");
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToken(token: string): string {
  const lowered = token.toLowerCase();
  const mapped = VARIANT_MAP[lowered] || lowered;
  if (mapped.endsWith("s") && mapped.length > 4 && !mapped.endsWith("sis")) {
    return mapped.slice(0, -1);
  }
  return mapped;
}

/**
 * Tokenize and normalize text into comparison tokens.
 *
 * @param value - Raw text to tokenize.
 * @returns Normalized tokens with stopwords removed.
 */
export function normalizeTokens(value: string): string[] {
  const normalized = normalizeForComparison(value);
  if (!normalized) return [];
  const tokens = normalized
    .split(" ")
    .map(token => normalizeToken(token))
    .filter(token => token && token.length >= 3 && !STOPWORDS.has(token));
  return tokens;
}
