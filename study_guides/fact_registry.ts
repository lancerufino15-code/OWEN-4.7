/**
 * Fact registry builder for maximal study guide generation (MH7).
 *
 * Used by: `src/index.ts` and `render_maximal_html.ts` to map Step A facts
 * into structured topic fields with slide/page provenance.
 *
 * Key exports:
 * - Fact registry types (`FactRegistry*`, `Mh7OmittedTopic`).
 * - `buildFactRegistryFromStepA`, `filterMh7Topics`, and helpers.
 *
 * Assumptions:
 * - Inputs are already sanitized and normalized.
 * - Heuristic regexes are used to bucket facts; results are best-effort.
 */
import type { StepAOutput } from "../machine/render_study_guide_html";
import { normalizeForComparison, normalizeTokens } from "./normalize";
import { classifyTopicLabel, isGarbageTopicLabel, type TopicInventory, type TopicKind } from "./inventory";

/**
 * Canonical fact span with slide/page provenance.
 */
export type FactRegistrySpan = {
  id: string;
  text: string;
  slides?: number[];
  pages?: number[];
};

/**
 * Fact entry tied to a span id for provenance.
 */
export type FactRegistryFact = {
  text: string;
  span_id: string;
};

/**
 * Field buckets for a topic in the MH7 schema.
 */
export type FactRegistryFields = {
  definition_or_role: FactRegistryFact[];
  mechanism: FactRegistryFact[];
  clinical_use_indications: FactRegistryFact[];
  toxicity_adverse_effects: {
    common: FactRegistryFact[];
    serious: FactRegistryFact[];
  };
  pk_pearls: FactRegistryFact[];
  contraindications_warnings: FactRegistryFact[];
  monitoring: FactRegistryFact[];
  dosing_regimens_if_given: FactRegistryFact[];
  interactions_genetics: FactRegistryFact[];
};

/**
 * Topic entry with classified kind and fact fields.
 */
export type FactRegistryTopic = {
  topic_id: string;
  label: string;
  kind: TopicKind;
  fields: FactRegistryFields;
};

/**
 * Collection of topics and shared spans for a lecture.
 */
export type FactRegistry = {
  topics: FactRegistryTopic[];
  spans: FactRegistrySpan[];
};

/**
 * Default minimum facts required per topic in MH7 filtering.
 */
export const MH7_MIN_FACTS_PER_TOPIC = 3;

/**
 * Explanation for a topic omitted from MH7 coverage.
 */
export type Mh7OmittedTopic = {
  topic_id: string;
  label: string;
  kind: TopicKind;
  fact_count: number;
  reason: "insufficient_facts" | "disallowed_kind" | "missing_drug_fields";
  missing_fields?: string[];
};

type SlideTextBlock = { n: number; page?: number; text: string };

type FactCandidate = {
  text: string;
  slides?: number[];
  pages?: number[];
};

const MECHANISM_FACT_HINTS =
  /(mechanism|inhibit|block|bind|calcineurin|nfat|mTOR|il-2|cd28|cd80|cd86|signal|transcription|t[- ]cell|b[- ]cell)/i;
const CLINICAL_USE_HINTS =
  /(induction|maintenance|rescue|used for|use for|used in|prophylaxis|prevention|treat(ment)? of|first[- ]line|second[- ]line|transplant)/i;
const TOXICITY_HINTS =
  /(tox|adverse|side effect|nephrotox|neurotox|infection|malignan|hypertension|hyperlipid|myelosuppression|leukopenia|anemia|diarrhea|teratogen|pregnan|pml|ptld)/i;
const SERIOUS_TOX_HINTS =
  /(black box|boxed|fatal|life[- ]threatening|pml|ptld|lymphoma|malignan|contraindicat|avoid.*pregnan|teratogen)/i;
const PK_HINTS = /(half[- ]?life|t1\/2|cyp|auc|bioavailability|metabolized|clearance|trough|xr|xl|extended[- ]release|p[- ]gp)/i;
const CONTRA_HINTS = /(contraindicat|avoid|warning|boxed|ebv seronegative|pregnan|lactation|do not use)/i;
const MONITOR_HINTS = /(monitor|trough|level|cbc|lft|renal|creatinine|infection|blood pressure|bp)/i;
const DOSING_HINTS = /(dose|dosing|mg\/kg|mg\b|q\d|daily|weekly|monthly|day\s*\d|week\s*\d|schedule|timing|loading)/i;
const INTERACTION_HINTS = /(cyp3a5|cyp3a4|tpmt|nudt15|hla|genotype|polymorphism|expressor|grapefruit|drug interaction)/i;

const MAX_FACT_LENGTH = 280;
const PLACEHOLDER_FACT_PATTERN = /\b(not stated|not specified|not provided|not in lecture|n\/a)\b/i;

const cleanWhitespace = (value: string) => (value || "").replace(/\s+/g, " ").trim();

function buildTopicId(label: string): string {
  const normalized = normalizeForComparison(label);
  if (normalized) return normalized.replace(/\s+/g, "_");
  return label.toLowerCase().replace(/\s+/g, "_").slice(0, 80);
}

function matchesTopic(text: string, topic: string): boolean {
  const normalizedTopic = normalizeForComparison(topic);
  const normalizedText = normalizeForComparison(text);
  if (!normalizedText || !normalizedTopic) return false;
  if (normalizedText.includes(normalizedTopic)) return true;
  const topicTokens = normalizeTokens(topic);
  if (!topicTokens.length) return false;
  const textTokens = new Set(normalizeTokens(text));
  return topicTokens.every(token => textTokens.has(token));
}

function shouldUseFact(text: string): boolean {
  const cleaned = cleanWhitespace(text);
  if (!cleaned) return false;
  if (cleaned.length < 3) return false;
  if (cleaned.length > MAX_FACT_LENGTH) return false;
  if (/^[-*]+\s*$/.test(cleaned)) return false;
  return true;
}

function createEmptyFields(): FactRegistryFields {
  return {
    definition_or_role: [],
    mechanism: [],
    clinical_use_indications: [],
    toxicity_adverse_effects: { common: [], serious: [] },
    pk_pearls: [],
    contraindications_warnings: [],
    monitoring: [],
    dosing_regimens_if_given: [],
    interactions_genetics: [],
  };
}

function addFact(target: FactRegistryFact[], entry: FactRegistryFact) {
  if (!entry.text || !entry.span_id) return;
  if (target.some(item => item.text === entry.text && item.span_id === entry.span_id)) return;
  target.push(entry);
}

function categorizeFactText(text: string): Array<{ field: keyof FactRegistryFields; sub?: "common" | "serious" }> {
  const categories: Array<{ field: keyof FactRegistryFields; sub?: "common" | "serious" }> = [];
  if (DOSING_HINTS.test(text)) categories.push({ field: "dosing_regimens_if_given" });
  if (INTERACTION_HINTS.test(text)) categories.push({ field: "interactions_genetics" });
  if (PK_HINTS.test(text)) categories.push({ field: "pk_pearls" });
  if (MONITOR_HINTS.test(text)) categories.push({ field: "monitoring" });
  if (CONTRA_HINTS.test(text)) categories.push({ field: "contraindications_warnings" });
  if (TOXICITY_HINTS.test(text)) {
    categories.push({ field: "toxicity_adverse_effects", sub: SERIOUS_TOX_HINTS.test(text) ? "serious" : "common" });
  }
  if (MECHANISM_FACT_HINTS.test(text)) categories.push({ field: "mechanism" });
  if (CLINICAL_USE_HINTS.test(text)) categories.push({ field: "clinical_use_indications" });
  return categories;
}

function registerSpan(
  spans: FactRegistrySpan[],
  spanIndex: Map<string, FactRegistrySpan>,
  candidate: FactCandidate,
): string {
  const cleaned = cleanWhitespace(candidate.text);
  const key = normalizeForComparison(cleaned) || cleaned.toLowerCase();
  const existing = spanIndex.get(key);
  if (existing) {
    const slideSet = new Set(existing.slides || []);
    const pageSet = new Set(existing.pages || []);
    for (const slide of candidate.slides || []) slideSet.add(slide);
    for (const page of candidate.pages || []) pageSet.add(page);
    existing.slides = Array.from(slideSet).sort((a, b) => a - b);
    existing.pages = Array.from(pageSet).sort((a, b) => a - b);
    return existing.id;
  }
  const id = `S${spans.length + 1}`;
  const span: FactRegistrySpan = {
    id,
    text: cleaned,
    slides: candidate.slides?.length ? Array.from(new Set(candidate.slides)).sort((a, b) => a - b) : undefined,
    pages: candidate.pages?.length ? Array.from(new Set(candidate.pages)).sort((a, b) => a - b) : undefined,
  };
  spans.push(span);
  spanIndex.set(key, span);
  return id;
}

function gatherTopicFacts(topic: string, stepA: StepAOutput, slides: SlideTextBlock[]): FactCandidate[] {
  const candidates: FactCandidate[] = [];
  const seen = new Set<string>();
  const matchingSlides = new Set<number>();
  const addCandidate = (text: string, slide?: number, page?: number) => {
    const cleaned = cleanWhitespace(text);
    if (!shouldUseFact(cleaned)) return;
    const key = normalizeForComparison(cleaned) || cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      text: cleaned,
      slides: slide ? [slide] : undefined,
      pages: page ? [page] : undefined,
    });
  };

  for (const slide of stepA.slides || []) {
    const slidePage = slide.page;
    let slideHasMatch = false;
    for (const section of slide.sections || []) {
      const heading = section.heading || "";
      const headingMatches = heading && matchesTopic(heading, topic);
      if (headingMatches) {
        slideHasMatch = true;
        for (const fact of section.facts || []) {
          addCandidate(fact.text || "", slide.n, slidePage);
        }
      }
      for (const fact of section.facts || []) {
        if (matchesTopic(fact.text || "", topic)) {
          slideHasMatch = true;
          addCandidate(fact.text || "", slide.n, slidePage);
        }
      }
    }
    if (slideHasMatch) {
      matchingSlides.add(slide.n);
    }
  }

  for (const fact of stepA.raw_facts || []) {
    if (matchesTopic(fact || "", topic)) addCandidate(fact || "");
  }
  for (const fact of stepA.exam_atoms || []) {
    if (matchesTopic(fact || "", topic)) addCandidate(fact || "");
  }
  for (const span of stepA.source_spans || []) {
    if (matchesTopic(span.text || "", topic)) {
      addCandidate(span.text || "", span.slides?.[0], span.pages?.[0]);
    }
  }
  for (const slide of slides || []) {
    const lines = (slide.text || "").split("\n");
    const slideMatches = matchingSlides.has(slide.n) || lines.some(line => matchesTopic(line || "", topic));
    if (slideMatches) {
      for (const line of lines) {
        const cleaned = cleanWhitespace(line);
        if (!shouldUseFact(cleaned)) continue;
        if (isGarbageTopicLabel(cleaned)) continue;
        addCandidate(cleaned, slide.n, slide.page);
      }
      continue;
    }
    for (const line of lines) {
      if (matchesTopic(line || "", topic)) {
        addCandidate(line || "", slide.n, slide.page);
      }
    }
  }

  return candidates;
}

/**
 * Build a fact registry from Step A output and slide text.
 *
 * @param opts - Inputs including Step A output, topic inventory, and slide text.
 * @returns Fact registry with topics and spans.
 */
export function buildFactRegistryFromStepA(opts: {
  stepA: StepAOutput;
  inventory: TopicInventory;
  slides: SlideTextBlock[];
}): FactRegistry {
  const spans: FactRegistrySpan[] = [];
  const spanIndex = new Map<string, FactRegistrySpan>();
  const topics: FactRegistryTopic[] = [];
  const seenTopics = new Set<string>();

  const topicLabels = [
    ...(opts.inventory.conditions || []),
    ...(opts.inventory.processes || []),
  ];

  for (const label of topicLabels) {
    const cleaned = cleanWhitespace(label);
    const normalized = normalizeForComparison(cleaned);
    if (!cleaned || !normalized) continue;
    if (seenTopics.has(normalized)) continue;
    seenTopics.add(normalized);
    const kind = classifyTopicLabel(cleaned);
    if (kind === "garbage") continue;
    const fields = createEmptyFields();
    const candidates = gatherTopicFacts(cleaned, opts.stepA, opts.slides);

    for (const candidate of candidates) {
      const spanId = registerSpan(spans, spanIndex, candidate);
      const entry: FactRegistryFact = { text: candidate.text, span_id: spanId };
      const categories = categorizeFactText(candidate.text);
      if (!categories.length) {
        addFact(fields.definition_or_role, entry);
        continue;
      }
      for (const category of categories) {
        if (category.field === "toxicity_adverse_effects") {
          if (category.sub === "serious") addFact(fields.toxicity_adverse_effects.serious, entry);
          else addFact(fields.toxicity_adverse_effects.common, entry);
        } else {
          addFact(fields[category.field] as FactRegistryFact[], entry);
        }
      }
    }

    topics.push({
      topic_id: buildTopicId(cleaned),
      label: cleaned,
      kind,
      fields,
    });
  }

  return { topics, spans };
}

/**
 * Select a representative fact text from a list, skipping placeholders.
 *
 * @param items - Fact list to select from.
 * @param opts - Optional matcher to pick a specific fact.
 * @returns Selected fact text or empty string.
 */
export function selectFactText(items: FactRegistryFact[], opts?: { match?: RegExp }): string | "" {
  const list = Array.isArray(items) ? items : [];
  const filtered = list.filter(item => item?.text && !PLACEHOLDER_FACT_PATTERN.test(item.text));
  if (!filtered.length) return "";
  if (opts?.match) {
    const found = filtered.find(item => opts.match?.test(item.text));
    if (found) return found.text;
  }
  return filtered[0]?.text || "";
}

function sanitizeFacts(
  items: Array<{ text?: string; span_id?: string }>,
  validSpanIds: Set<string>,
): FactRegistryFact[] {
  const safe: FactRegistryFact[] = [];
  for (const item of items || []) {
    const text = cleanWhitespace(item?.text || "");
    const spanId = item?.span_id || "";
    if (!text || !spanId || !validSpanIds.has(spanId)) continue;
    if (safe.some(existing => existing.text === text && existing.span_id === spanId)) continue;
    safe.push({ text, span_id: spanId });
  }
  return safe;
}

/**
 * Coerce a rewritten registry to valid spans/fields from the original.
 *
 * @param registry - Original registry with canonical spans.
 * @param rewritten - User/LLM rewritten registry candidate.
 * @returns A sanitized registry aligned to original spans.
 */
export function coerceFactRegistryRewrite(registry: FactRegistry, rewritten: any): FactRegistry {
  const validSpanIds = new Set((registry.spans || []).map(span => span.id));
  const rewrittenTopics = Array.isArray(rewritten?.topics) ? rewritten.topics : [];
  const topicById = new Map<string, any>();
  for (const topic of rewrittenTopics) {
    if (topic?.topic_id) topicById.set(String(topic.topic_id), topic);
  }

  const topics = registry.topics.map(topic => {
    const candidate = topicById.get(topic.topic_id);
    if (!candidate?.fields) return topic;
    const fields = candidate.fields || {};
    const coerced: FactRegistryFields = {
      definition_or_role: sanitizeFacts(fields.definition_or_role || [], validSpanIds),
      mechanism: sanitizeFacts(fields.mechanism || [], validSpanIds),
      clinical_use_indications: sanitizeFacts(fields.clinical_use_indications || [], validSpanIds),
      toxicity_adverse_effects: {
        common: sanitizeFacts(fields.toxicity_adverse_effects?.common || [], validSpanIds),
        serious: sanitizeFacts(fields.toxicity_adverse_effects?.serious || [], validSpanIds),
      },
      pk_pearls: sanitizeFacts(fields.pk_pearls || [], validSpanIds),
      contraindications_warnings: sanitizeFacts(fields.contraindications_warnings || [], validSpanIds),
      monitoring: sanitizeFacts(fields.monitoring || [], validSpanIds),
      dosing_regimens_if_given: sanitizeFacts(fields.dosing_regimens_if_given || [], validSpanIds),
      interactions_genetics: sanitizeFacts(fields.interactions_genetics || [], validSpanIds),
    };
    return { ...topic, fields: coerced };
  });

  return { topics, spans: registry.spans };
}

function normalizeFactKey(text: string): string {
  const normalized = normalizeForComparison(text);
  return normalized || cleanWhitespace(text).toLowerCase();
}

/**
 * Count unique facts in a topic across all fields.
 *
 * @param topic - Topic entry to inspect.
 * @returns Number of unique fact strings.
 */
export function countTopicFacts(topic: FactRegistryTopic): number {
  const seen = new Set<string>();
  const add = (items: FactRegistryFact[]) => {
    for (const item of items || []) {
      const key = normalizeFactKey(item.text || "");
      if (!key) continue;
      seen.add(key);
    }
  };
  add(topic.fields.definition_or_role);
  add(topic.fields.mechanism);
  add(topic.fields.clinical_use_indications);
  add(topic.fields.toxicity_adverse_effects.common);
  add(topic.fields.toxicity_adverse_effects.serious);
  add(topic.fields.pk_pearls);
  add(topic.fields.contraindications_warnings);
  add(topic.fields.monitoring);
  add(topic.fields.dosing_regimens_if_given);
  add(topic.fields.interactions_genetics);
  return seen.size;
}

/**
 * Identify missing drug coverage requirements for MH7 validation.
 *
 * @param topic - Topic entry to inspect.
 * @returns List of missing field labels (empty when coverage is sufficient).
 */
export function getMissingDrugCoverageFields(topic: FactRegistryTopic): string[] {
  if (topic.kind !== "drug") return [];
  const missing: string[] = [];
  const toxCount =
    (topic.fields.toxicity_adverse_effects.common || []).length +
    (topic.fields.toxicity_adverse_effects.serious || []).length;
  if (!topic.fields.mechanism.length) missing.push("mechanism");
  if (toxCount < 2) missing.push("toxicity>=2");
  if (!topic.fields.pk_pearls.length) missing.push("pk_pearls");
  if (!topic.fields.clinical_use_indications.length) missing.push("clinical_use_indications");
  return missing;
}

/**
 * Filter topics for MH7 coverage based on fact count and kind.
 *
 * @param topics - Topic list to filter.
 * @param opts - Optional thresholds and kind requirements.
 * @returns Kept topics plus omitted reasons and effective minFacts.
 */
export function filterMh7Topics(
  topics: FactRegistryTopic[],
  opts?: { minFacts?: number; allowedKinds?: TopicKind[]; requireDrugCoverage?: boolean },
): { kept: FactRegistryTopic[]; omitted: Mh7OmittedTopic[]; minFacts: number } {
  const minFacts = typeof opts?.minFacts === "number" ? opts.minFacts : MH7_MIN_FACTS_PER_TOPIC;
  const allowedKinds = new Set<TopicKind>(opts?.allowedKinds || ["drug", "drug_class", "condition", "process"]);
  const requireDrugCoverage = opts?.requireDrugCoverage !== false;
  const kept: FactRegistryTopic[] = [];
  const omitted: Mh7OmittedTopic[] = [];

  // MH7 constraint: omit topics that are not allowed kinds or lack sufficient lecture-grounded facts.
  for (const topic of topics || []) {
    const factCount = countTopicFacts(topic);
    if (!allowedKinds.has(topic.kind)) {
      omitted.push({
        topic_id: topic.topic_id,
        label: topic.label,
        kind: topic.kind,
        fact_count: factCount,
        reason: "disallowed_kind",
      });
      continue;
    }
    if (factCount < minFacts) {
      omitted.push({
        topic_id: topic.topic_id,
        label: topic.label,
        kind: topic.kind,
        fact_count: factCount,
        reason: "insufficient_facts",
      });
      continue;
    }
    if (requireDrugCoverage && topic.kind === "drug") {
      const missingFields = getMissingDrugCoverageFields(topic);
      if (missingFields.length) {
        omitted.push({
          topic_id: topic.topic_id,
          label: topic.label,
          kind: topic.kind,
          fact_count: factCount,
          reason: "missing_drug_fields",
          missing_fields: missingFields,
        });
        continue;
      }
    }
    kept.push(topic);
  }
  return { kept, omitted, minFacts };
}
