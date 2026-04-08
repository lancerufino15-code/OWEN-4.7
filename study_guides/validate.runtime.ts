/**
 * Runtime validators for maximal study guide HTML and content coverage.
 *
 * Used by: `src/index.ts` to enforce MH7 quality constraints before returning
 * or persisting study guide output.
 *
 * Key exports:
 * - `validateStyleContract` and `validateMaximalStructure` for HTML checks.
 * - `ensureMaximal*` helpers that throw on quality failures.
 *
 * Assumptions:
 * - Input HTML is a full document string produced by the renderers.
 */
import { CANONICAL_STYLE_CONTRACT, MAXIMAL_COVERAGE_CONTRACT } from "./contracts";
import {
  MH7_MIN_FACTS_PER_TOPIC,
  countTopicFacts,
  getMissingDrugCoverageFields,
  type FactRegistry,
} from "./fact_registry";
import { normalizeForComparison, normalizeTokens } from "./normalize";
import { isGarbageTopicLabel, type TopicInventory, type TopicKind } from "./inventory";
import { TABLE_SCHEMA_LIST, type TableSchema } from "./table_schemas";

type StyleValidationResult = { ok: true } | { ok: false; missing: string[] };

const stripHtmlTags = (html: string) =>
  (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const decodeHtmlEntities = (value: string) =>
  (value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

function removeAppendix(html: string) {
  let cleaned = html || "";
  for (const selector of MAXIMAL_COVERAGE_CONTRACT.appendixSelectors) {
    if (selector.startsWith("#")) {
      const id = selector.replace(/^#/, "");
      const sectionPattern = new RegExp(`<section[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/section>`, "gi");
      const genericPattern = new RegExp(`<[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/[^>]+>`, "gi");
      cleaned = cleaned.replace(sectionPattern, " ");
      cleaned = cleaned.replace(genericPattern, " ");
      continue;
    }
    if (selector.startsWith(".")) {
      const className = selector.replace(/^\./, "");
      const classPattern = new RegExp(
        `<[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>[\\s\\S]*?<\\/[^>]+>`,
        "gi",
      );
      cleaned = cleaned.replace(classPattern, " ");
    }
  }
  return cleaned;
}

function extractMainContent(html: string): { content: string; found: boolean } {
  const match = (html || "").match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (match && match[1]) {
    return { content: match[1], found: true };
  }
  return { content: html || "", found: false };
}

function extractHeadingTitles(html: string): string[] {
  const headings = Array.from((html || "").matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi)).map(match =>
    stripHtmlTags(match[1] || ""),
  );
  return headings.filter(Boolean);
}

function normalizeHeaderLabel(label: string): string {
  return (label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchesRequiredHeader(schema: TableSchema, required: string, normalizedHeaders: string[]): boolean {
  const aliases = schema.allowedHeaderAliases?.[required] || [];
  const candidates = [required, ...aliases].map(normalizeHeaderLabel).filter(Boolean);
  return candidates.some(candidate => normalizedHeaders.includes(candidate));
}

function extractTableById(html: string, id: string): string | null {
  const pattern = new RegExp(`<table[^>]*data-table-id=["']${id}["'][^>]*>[\\s\\S]*?<\\/table>`, "i");
  const match = (html || "").match(pattern);
  return match ? match[0] : null;
}

function extractTableHeaders(tableHtml: string): string[] {
  const headers: string[] = [];
  const matches = Array.from((tableHtml || "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi));
  for (const match of matches) {
    const raw = decodeHtmlEntities(stripHtmlTags(match[1] || ""));
    const cleaned = (raw || "").trim();
    if (cleaned) headers.push(cleaned);
  }
  return headers;
}

/**
 * Validate required CSS classes/legend/table styles in the HTML.
 *
 * @param html - Rendered study guide HTML.
 * @returns StyleValidationResult with missing entries if any.
 */
export function validateStyleContract(html: string): StyleValidationResult {
  const missing: string[] = [];
  const lower = (html || "").toLowerCase();

  for (const cls of CANONICAL_STYLE_CONTRACT.requiredHighlightClasses) {
    const selector = `.${cls.replace(" ", ".")}`;
    if (!lower.includes(selector)) {
      missing.push(`css:${selector}`);
    }
  }

  if (!/class="[^"]*\blegend\b/i.test(html)) {
    missing.push("legend:container");
  }

  for (const item of CANONICAL_STYLE_CONTRACT.requiredLegendItems) {
    const pillRegex = new RegExp(`class="[^"]*\\bpill\\b[^"]*\\b${item.className}\\b`, "i");
    if (!pillRegex.test(html)) {
      missing.push(`legend:${item.className}`);
    }
  }

  for (const tableClass of CANONICAL_STYLE_CONTRACT.requiredTableClassNames) {
    const tableRegex = new RegExp(`<table[^>]*class="[^"]*\\b${tableClass}\\b`, "i");
    if (!tableRegex.test(html)) {
      missing.push(`table:${tableClass}`);
    }
  }

  return missing.length ? { ok: false, missing } : { ok: true };
}

/**
 * Ensure the main body references all expected topics.
 *
 * @param inventoryOrTopics - Topic inventory or explicit topic list.
 * @param html - Rendered study guide HTML.
 * @throws Error with code `MAXIMAL_COVERAGE_FAILED` when topics are missing.
 */
export function ensureMaximalCoverage(inventoryOrTopics: TopicInventory | string[], html: string) {
  const expectedTopics = Array.isArray(inventoryOrTopics)
    ? inventoryOrTopics
    : inventoryOrTopics.conditions || [];
  const main = extractMainContent(html || "");
  const base = removeAppendix(main.content || "");
  const mainText = normalizeForComparison(stripHtmlTags(base));
  const mainTokens = new Set(normalizeTokens(mainText));
  const missing: string[] = [];
  const missingNormalized: string[] = [];

  for (const topic of expectedTopics) {
    const normalized = normalizeForComparison(topic);
    if (!normalized) continue;
    if (mainText.includes(normalized)) continue;
    const tokens = normalizeTokens(topic);
    const tokenMatch = tokens.length > 0 && tokens.every(token => mainTokens.has(token));
    if (tokenMatch) continue;
    missing.push(topic);
    missingNormalized.push(normalized);
  }
  if (missing.length) {
    const headings = extractHeadingTitles(base);
    const error = new Error(
      `MAXIMAL_COVERAGE_FAILED: missing topics (${missing.length}) -> ${missing.join(", ")}; normalized=${missingNormalized.join(", ")}; sections=${headings.join(" | ")}`,
    );
    (error as any).code = "MAXIMAL_COVERAGE_FAILED";
    (error as any).missing = missing;
    (error as any).missingNormalized = missingNormalized;
    (error as any).sections = headings;
    (error as any).mainBodyFound = main.found;
    throw error;
  }
}

/**
 * Reject placeholder language in maximal outputs.
 *
 * @param html - Rendered study guide HTML.
 * @param opts - Optional placeholder strings to check.
 * @throws Error with code `MAXIMAL_QUALITY_FAILED_PLACEHOLDERS` when found.
 */
export function ensureMaximalPlaceholderQuality(html: string, opts?: { placeholders?: string[] }) {
  // MH7 constraint: reject placeholder language instead of emitting it.
  const placeholders = opts?.placeholders || [
    "not stated",
    "not specified",
    "not provided",
    "not in lecture",
    "n/a",
  ];
  const offenders: string[] = [];
  for (const placeholder of placeholders) {
    const regex = new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = (html || "").match(regex) || [];
    if (matches.length) offenders.push(placeholder);
  }
  if (!offenders.length) return;
  const error = new Error(`MAXIMAL_QUALITY_FAILED_PLACEHOLDERS: ${offenders.join(", ")}`);
  (error as any).code = "MAXIMAL_QUALITY_FAILED_PLACEHOLDERS";
  (error as any).offenders = offenders;
  throw error;
}

/**
 * Ensure topic extraction did not keep garbage headings.
 *
 * @param inventory - Topic inventory to validate.
 * @throws Error with code `MAXIMAL_QUALITY_FAILED_TOPIC_CLASSIFICATION` on failures.
 */
export function ensureMaximalTopicClassification(inventory: TopicInventory) {
  const candidates = [
    ...(inventory.conditions || []),
    ...(inventory.drugs || []),
    ...(inventory.drug_classes || []),
    ...(inventory.phenotypes || []),
    ...(inventory.processes || []),
  ];
  // MH7 constraint: headings/formatting artifacts must not survive topic extraction.
  const offenders = candidates.filter(item => isGarbageTopicLabel(item));
  if (offenders.length) {
    const error = new Error(
      `MAXIMAL_QUALITY_FAILED_TOPIC_CLASSIFICATION: ${offenders.length} invalid topics -> ${offenders.join(", ")}`,
    );
    (error as any).code = "MAXIMAL_QUALITY_FAILED_TOPIC_CLASSIFICATION";
    (error as any).offenders = offenders;
    throw error;
  }
}

/**
 * Ensure maximal output covers a minimum ratio of extracted topics.
 *
 * @param inventory - Topic inventory baseline.
 * @param html - Rendered study guide HTML.
 * @param opts - Optional threshold overrides.
 * @throws Error with code `MAXIMAL_QUALITY_FAILED_TOPIC_DENSITY` on failures.
 */
export function ensureMaximalTopicDensity(
  input: FactRegistry | FactRegistry["topics"],
  opts?: { minFacts?: number; kinds?: TopicKind[] },
) {
  const topics = Array.isArray(input) ? input : input.topics || [];
  const minFacts = typeof opts?.minFacts === "number" ? opts.minFacts : MH7_MIN_FACTS_PER_TOPIC;
  const allowedKinds = new Set<TopicKind>(opts?.kinds || ["drug", "drug_class", "condition", "process"]);
  const invalidKinds = topics.filter(topic => !allowedKinds.has(topic.kind));
  if (invalidKinds.length) {
    const error = new Error(
      `MAXIMAL_QUALITY_FAILED_TOPIC_KIND: ${invalidKinds.map(topic => topic.label).join(", ")}`,
    );
    (error as any).code = "MAXIMAL_QUALITY_FAILED_TOPIC_KIND";
    (error as any).offenders = invalidKinds;
    throw error;
  }
  // MH7 constraint: topics included in maximal output must hit the minimum fact density.
  const offenders = topics.filter(topic => countTopicFacts(topic) < minFacts);
  if (!offenders.length) return;
  const summary = offenders.map(topic => `${topic.label}(${countTopicFacts(topic)})`).join(", ");
  const error = new Error(`MAXIMAL_QUALITY_FAILED_TOPIC_DENSITY: ${summary}`);
  (error as any).code = "MAXIMAL_QUALITY_FAILED_TOPIC_DENSITY";
  (error as any).offenders = offenders;
  (error as any).minFacts = minFacts;
  throw error;
}

/**
 * Ensure drug topics meet minimum MH7 coverage requirements.
 *
 * @param input - Full registry or list of topics to check.
 * @throws Error with code `MAXIMAL_QUALITY_FAILED_DRUG_COVERAGE` on failures.
 */
export function ensureMaximalDrugCoverage(input: FactRegistry | FactRegistry["topics"]) {
  const topics = Array.isArray(input) ? input : input.topics || [];
  const missing: Array<{ drug: string; missing: string[] }> = [];
  // MH7 constraint: any drug included in output must have mechanism + 2 tox + PK + clinical use.
  for (const topic of topics) {
    if (topic.kind !== "drug") continue;
    const missingFields = getMissingDrugCoverageFields(topic);
    if (missingFields.length) {
      missing.push({ drug: topic.label, missing: missingFields });
    }
  }
  if (missing.length) {
    const summary = missing.map(item => `${item.drug}: ${item.missing.join("|")}`).join("; ");
    const error = new Error(`MAXIMAL_QUALITY_FAILED_DRUG_COVERAGE: ${summary}`);
    (error as any).code = "MAXIMAL_QUALITY_FAILED_DRUG_COVERAGE";
    (error as any).missing = missing;
    throw error;
  }
}

/**
 * Ensure required discriminator tables and headers exist.
 *
 * @param html - Rendered study guide HTML.
 * @throws Error with code `MAXIMAL_QUALITY_FAILED_*` on missing tables/headers.
 */
export function ensureMaximalDiscriminatorColumns(html: string) {
  // MH7 constraint: required schemas must appear with canonical headers or aliases.
  const haystack = html || "";
  const missingTables: string[] = [];
  const headerFailures: Array<{
    id: string;
    expected: string[];
    detected: string[];
    missing: string[];
  }> = [];

  const tableToken = (id: string) => [
    `data-table-id="${id}"`,
    `data-table-id='${id}'`,
  ];

  for (const schema of TABLE_SCHEMA_LIST) {
    if (!schema.mustExistInMaximal) continue;
    const tokens = tableToken(schema.id);
    if (!tokens.some(token => haystack.includes(token))) {
      missingTables.push(schema.id);
    }
  }

  if (missingTables.length) {
    const idx = haystack.indexOf("<table");
    const snippet = idx >= 0 ? haystack.slice(idx, idx + 300) : haystack.slice(0, 300);
    const error = new Error(
      `MAXIMAL_QUALITY_FAILED_MISSING_TABLE: ${missingTables.join(", ")}; snippet=${snippet}`,
    );
    (error as any).code = "MAXIMAL_QUALITY_FAILED_MISSING_TABLE";
    (error as any).missing = missingTables;
    (error as any).snippet = snippet;
    throw error;
  }

  for (const schema of TABLE_SCHEMA_LIST) {
    if (!schema.mustExistInMaximal) continue;
    const tableHtml = extractTableById(html || "", schema.id);
    if (!tableHtml) {
      continue;
    }
    const detected = extractTableHeaders(tableHtml);
    const normalized = detected.map(normalizeHeaderLabel).filter(Boolean);
    const missing = schema.requiredHeaders.filter(required => !matchesRequiredHeader(schema, required, normalized));
    if (missing.length) {
      headerFailures.push({
        id: schema.id,
        expected: schema.requiredHeaders,
        detected,
        missing,
      });
    }
  }

  if (missingTables.length) {
    const error = new Error(`MAXIMAL_QUALITY_FAILED_MISSING_TABLE: ${missingTables.join(", ")}`);
    (error as any).code = "MAXIMAL_QUALITY_FAILED_MISSING_TABLE";
    (error as any).missing = missingTables;
    throw error;
  }

  if (headerFailures.length) {
    const details = headerFailures
      .map(failure => {
        return `${failure.id} missing=${failure.missing.join("|")} detected=${failure.detected.join("|")} expected=${failure.expected.join("|")}`;
      })
      .join(" ; ");
    const error = new Error(`MAXIMAL_QUALITY_FAILED_DISCRIMINATOR_COLUMNS: ${details}`);
    (error as any).code = "MAXIMAL_QUALITY_FAILED_DISCRIMINATOR_COLUMNS";
    (error as any).tables = headerFailures;
    throw error;
  }
}

/**
 * Validate required section ids are present in maximal output.
 *
 * @param html - Rendered study guide HTML.
 * @returns StyleValidationResult with missing section ids if any.
 */
export function validateMaximalStructure(html: string): StyleValidationResult {
  const missing: string[] = [];
  const requiredIds = [
    "core-conditions",
    "condition-coverage",
    "rapid-approach-summary",
    "differential-diagnosis",
    "cutoffs-formulas",
    "coverage-qa",
    "slide-by-slide-appendix",
  ];
  for (const id of requiredIds) {
    const regex = new RegExp(`id=["']${id}["']`, "i");
    if (!regex.test(html)) {
      missing.push(`section:${id}`);
    }
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}
