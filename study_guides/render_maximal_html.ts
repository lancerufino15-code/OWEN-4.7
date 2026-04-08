/**
 * Render the MH7/maximal study guide HTML from registry + inventory.
 *
 * Used by: `src/index.ts` to generate the "maximal" study guide output.
 *
 * Key exports:
 * - `renderMaximalStudyGuideHtml`: Main renderer for maximal HTML output.
 *
 * Assumptions:
 * - Inputs are sanitized and validated; this renderer only escapes HTML.
 * - Table schemas are enforced via `TABLE_SCHEMAS`.
 */
import type { StepAOutput } from "../machine/render_study_guide_html";
import { BASE_STUDY_GUIDE_CSS, renderLegend } from "./contracts";
import type {
  FactRegistry,
  FactRegistryFact,
  FactRegistryTopic,
  Mh7OmittedTopic,
} from "./fact_registry";
import { selectFactText, MH7_MIN_FACTS_PER_TOPIC } from "./fact_registry";
import type { TopicInventory, TopicKind } from "./inventory";
import { normalizeForComparison } from "./normalize";
import { TABLE_SCHEMAS, type TableSchemaId } from "./table_schemas";

type RenderMaximalOptions = {
  lectureTitle: string;
  buildUtc: string;
  slideCount: number;
  slides: Array<{ n: number; page?: number; text: string }>;
  inventory: TopicInventory;
  registry: FactRegistry;
  mh7?: { omitted: Mh7OmittedTopic[]; minFacts?: number };
  stepA?: StepAOutput;
  qaNotes?: string[];
  partial?: boolean;
};

const TOPIC_HIGHLIGHT: Record<TopicKind, string> = {
  drug: "treatment",
  drug_class: "treatment",
  condition: "disease",
  process: "mechanism",
  garbage: "buzz",
};

const TIMING_HINTS = /(minute|hour|day|week|month|year|immediate|delayed|early|late|rapid|within)/i;
const REJECTION_HINTS = /(rejection|gvhd)/i;
const MAX_FACT_WORDS = 20;
const PLACEHOLDER_FACT_PATTERN = /\b(not stated|not specified|not provided|not in lecture|n\/a)\b/i;

function escapeHtml(value: string): string {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isPlaceholderText(text: string): boolean {
  return PLACEHOLDER_FACT_PATTERN.test(text || "");
}

function renderTable(
  headers: string[],
  rows: string[][],
  tableClass = "",
  renderCell?: (cell: string, rowIdx: number, colIdx: number) => string,
  opts?: { tableId?: string },
): string[] {
  const tableId = opts?.tableId ? ` data-table-id=\"${escapeHtml(opts.tableId)}\"` : "";
  const lines = [`<table${tableClass ? ` class=\"${tableClass}\"` : ""}${tableId}>`];
  if (headers.length) {
    lines.push("  <thead>");
    lines.push("    <tr>");
    for (const header of headers) {
      lines.push(`      <th>${escapeHtml(header)}</th>`);
    }
    lines.push("    </tr>");
    lines.push("  </thead>");
  }
  lines.push("  <tbody>");
  const render = renderCell ?? ((cell: string) => escapeHtml(cell || ""));
  for (const [rowIdx, row] of (rows || []).entries()) {
    lines.push("    <tr>");
    for (const [colIdx, cell] of (row || []).entries()) {
      lines.push(`      <td>${render(cell || "", rowIdx, colIdx)}</td>`);
    }
    lines.push("    </tr>");
  }
  lines.push("  </tbody>");
  lines.push("</table>");
  return lines;
}

function normalizeTableRows(rows: string[][], columns: number): string[][] {
  const normalized: string[][] = [];
  for (const row of rows || []) {
    const trimmed = Array.isArray(row) ? row.slice(0, columns) : [];
    while (trimmed.length < columns) trimmed.push("");
    normalized.push(trimmed);
  }
  return normalized;
}

function renderSchemaTable(
  schemaId: TableSchemaId,
  rows: string[][],
  tableClass: string,
  renderCell?: (cell: string, rowIdx: number, colIdx: number) => string,
  opts?: { fallbackMessage?: string },
): string[] {
  const schema = TABLE_SCHEMAS[schemaId];
  let normalizedRows = normalizeTableRows(rows, schema.requiredHeaders.length);
  if (!normalizedRows.length && opts?.fallbackMessage) {
    normalizedRows = normalizeTableRows([[opts.fallbackMessage]], schema.requiredHeaders.length);
  }
  return renderTable(schema.requiredHeaders, normalizedRows, tableClass, renderCell, { tableId: schemaId });
}

function renderRapidApproachSummaryTable(rows: string[][], fallbackMessage?: string): string[] {
  return renderSchemaTable("rapid-approach-summary", rows, "tri", (cell) => cell || "", { fallbackMessage });
}

function renderTreatmentsManagementTable(rows: string[][], fallbackMessage?: string): string[] {
  return renderSchemaTable("treatments-management", rows, "compare", (cell) => cell || "", { fallbackMessage });
}

function renderRequiredMaximalTables(opts: {
  topics: FactRegistryTopic[];
  inventory: TopicInventory;
  partial?: boolean;
}): { rapid: string[]; treatments: string[] } {
  const fallbackMessage = opts.partial
    ? "Content missing due to partial extraction; see Coverage & QA."
    : "";
  const rapidRows = buildRapidApproachRows(opts.topics, 3);
  const candidateCount = Math.max(
    opts.inventory.drugs.length,
    opts.inventory.drug_classes.length,
    opts.topics.filter(topic => topic.kind === "drug" || topic.kind === "drug_class").length,
  );
  const treatmentRows = buildTreatmentsManagementRows(opts.topics, Math.min(5, candidateCount || 0));
  return {
    rapid: renderRapidApproachSummaryTable(rapidRows, fallbackMessage),
    treatments: renderTreatmentsManagementTable(treatmentRows, fallbackMessage),
  };
}

function renderList(items: string[], renderItem?: (item: string) => string): string[] {
  const filtered = (items || []).filter(item => !isPlaceholderText(item));
  if (!filtered.length) return [];
  const render = renderItem ?? ((item: string) => escapeHtml(item));
  const lines = ["<ul>"];
  for (const item of filtered) {
    lines.push(`  <li>${render(item)}</li>`);
  }
  lines.push("</ul>");
  return lines;
}

function renderTopicLabel(label: string, kind: TopicKind): string {
  const className = TOPIC_HIGHLIGHT[kind] || "disease";
  return `<span class="hl ${className}">${escapeHtml(label)}</span>`;
}

function clampWords(text: string, maxWords: number): string {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}

function renderFact(text: string, highlightClass: string): string {
  // MH7 constraint: keep facts short and exam-forward.
  const trimmed = clampWords(text, MAX_FACT_WORDS);
  return `<span class="hl ${highlightClass}">${escapeHtml(trimmed)}</span>`;
}

function resolveHighlightForField(field: string, topicKind: TopicKind): string {
  if (field === "mechanism") return "mechanism";
  if (field === "clinical_use_indications") return "treatment";
  if (field === "toxicity") return "symptom";
  if (field === "monitoring") return "diagnostic";
  if (field === "dosing") return "treatment";
  if (field === "interactions_genetics") return "gene";
  if (field === "pk") return "mechanism";
  if (field === "contraindications") return "symptom";
  return TOPIC_HIGHLIGHT[topicKind] || "disease";
}

function pickFact(...sources: Array<{ items: FactRegistryFact[]; match?: RegExp }>): string {
  for (const source of sources) {
    const text = selectFactText(source.items, { match: source.match });
    if (text) return text;
  }
  return "";
}

function flattenTopicFacts(topic: FactRegistryTopic): FactRegistryFact[] {
  return [
    ...topic.fields.definition_or_role,
    ...topic.fields.clinical_use_indications,
    ...topic.fields.mechanism,
    ...topic.fields.toxicity_adverse_effects.serious,
    ...topic.fields.toxicity_adverse_effects.common,
    ...topic.fields.pk_pearls,
    ...topic.fields.monitoring,
    ...topic.fields.dosing_regimens_if_given,
    ...topic.fields.contraindications_warnings,
    ...topic.fields.interactions_genetics,
  ];
}

function buildCoreTopicBullets(topic: FactRegistryTopic): string[] {
  const bullets: string[] = [];
  const used = new Set<string>();
  const addBullet = (label: string, text: string, highlightClass: string) => {
    if (!text || isPlaceholderText(text)) return;
    const key = `${label}:${text}`;
    if (used.has(key)) return;
    used.add(key);
    bullets.push(`${label}: ${renderFact(text, highlightClass)}`);
  };

  const context = pickFact(
    { items: topic.fields.definition_or_role },
    { items: topic.fields.clinical_use_indications },
  );
  addBullet("Context", context, resolveHighlightForField("definition", topic.kind));

  const clue = pickFact(
    { items: topic.fields.toxicity_adverse_effects.serious },
    { items: topic.fields.toxicity_adverse_effects.common },
    { items: topic.fields.mechanism },
  );
  addBullet("Key clue", clue, resolveHighlightForField("toxicity", topic.kind));

  const confirm = pickFact(
    { items: topic.fields.monitoring },
    { items: topic.fields.pk_pearls },
    { items: topic.fields.interactions_genetics },
  );
  addBullet("Confirm/Monitor", confirm, resolveHighlightForField("monitoring", topic.kind));

  const treat = pickFact(
    { items: topic.fields.dosing_regimens_if_given },
    { items: topic.fields.clinical_use_indications },
  );
  addBullet("Treat/Next", treat, resolveHighlightForField("dosing", topic.kind));

  if (bullets.length < 3) {
    const fallbackFacts = [
      ...topic.fields.mechanism,
      ...topic.fields.pk_pearls,
      ...topic.fields.toxicity_adverse_effects.serious,
      ...topic.fields.toxicity_adverse_effects.common,
      ...topic.fields.interactions_genetics,
      ...topic.fields.contraindications_warnings,
    ];
    for (const fact of fallbackFacts) {
      if (bullets.length >= 3) break;
      addBullet("Detail", fact.text, resolveHighlightForField("mechanism", topic.kind));
    }
  }

  return bullets.slice(0, 4);
}

function buildRapidApproachRows(topics: FactRegistryTopic[], minRows = 3): string[][] {
  const rows: Array<{ row: string[]; score: number; key: string }> = [];
  const seen = new Set<string>();

  const prioritize = [
    ...topics.filter(topic => topic.kind === "condition" && REJECTION_HINTS.test(topic.label)),
    ...topics.filter(topic => topic.kind === "drug_class"),
    ...topics.filter(topic => topic.kind === "drug"),
    ...topics.filter(topic => topic.kind === "condition"),
  ];

  for (const topic of prioritize) {
    const topicKey = normalizeForComparison(topic.label) || topic.topic_id;
    if (seen.has(topicKey)) continue;
    seen.add(topicKey);
    const timing = selectFactText(flattenTopicFacts(topic), { match: TIMING_HINTS });
    const clue = timing || pickFact(
      { items: topic.fields.toxicity_adverse_effects.serious },
      { items: topic.fields.toxicity_adverse_effects.common },
      { items: topic.fields.definition_or_role },
    );
    const why = pickFact(
      { items: topic.fields.mechanism },
      { items: topic.fields.definition_or_role },
    );
    const confirm = pickFact(
      { items: topic.fields.monitoring },
      { items: topic.fields.pk_pearls },
      { items: topic.fields.interactions_genetics },
    );
    const treat = pickFact(
      { items: topic.fields.dosing_regimens_if_given },
      { items: topic.fields.clinical_use_indications },
    );
    const score = [clue, why, confirm, treat].filter(Boolean).length;
    rows.push({
      score,
      key: topicKey,
      row: [
        clue ? renderFact(clue, resolveHighlightForField("toxicity", topic.kind)) : "",
        renderTopicLabel(topic.label, topic.kind),
        why ? renderFact(why, resolveHighlightForField("mechanism", topic.kind)) : "",
        confirm ? renderFact(confirm, resolveHighlightForField("monitoring", topic.kind)) : "",
        treat ? renderFact(treat, resolveHighlightForField("dosing", topic.kind)) : "",
      ],
    });
  }

  rows.sort((a, b) => b.score - a.score);
  const selected = rows.map(entry => entry.row);

  if (selected.length < minRows && selected.length > 0) {
    const filler = [...selected];
    let i = 0;
    while (selected.length < minRows) {
      selected.push(filler[i % filler.length]);
      i += 1;
    }
  }

  return selected;
}

function buildRejectionRows(topics: FactRegistryTopic[]): string[][] {
  const rows: string[][] = [];
  const normalizedTargets = ["hyperacute", "accelerated", "acute", "chronic"];
  for (const target of normalizedTargets) {
    const found = topics.find(topic => normalizeForComparison(topic.label).includes(target));
    if (!found) continue;
    const allFacts = flattenTopicFacts(found);
    const timing = selectFactText(allFacts, { match: TIMING_HINTS });
    const mechanism = pickFact({ items: found.fields.mechanism }, { items: found.fields.definition_or_role });
    const implication = pickFact(
      { items: found.fields.clinical_use_indications },
      { items: found.fields.toxicity_adverse_effects.serious },
    );
    if (timing && mechanism && implication) {
      rows.push([
        renderTopicLabel(found.label, found.kind),
        renderFact(timing, resolveHighlightForField("definition", found.kind)),
        renderFact(mechanism, resolveHighlightForField("mechanism", found.kind)),
        renderFact(implication, resolveHighlightForField("clinical_use_indications", found.kind)),
      ]);
    }
  }
  return rows;
}

function buildDrugClassRows(topics: FactRegistryTopic[]): string[][] {
  const rows: string[][] = [];
  for (const topic of topics) {
    if (topic.kind !== "drug_class") continue;
    const moa = selectFactText(topic.fields.mechanism);
    const toxicity = pickFact(
      { items: topic.fields.toxicity_adverse_effects.serious },
      { items: topic.fields.toxicity_adverse_effects.common },
    );
    const pk = selectFactText(topic.fields.pk_pearls);
    const use = selectFactText(topic.fields.clinical_use_indications);
    if (moa && toxicity && pk && use) {
      rows.push([
        renderTopicLabel(topic.label, topic.kind),
        renderFact(moa, resolveHighlightForField("mechanism", topic.kind)),
        renderFact(toxicity, resolveHighlightForField("toxicity", topic.kind)),
        renderFact(pk, resolveHighlightForField("pk", topic.kind)),
        renderFact(use, resolveHighlightForField("clinical_use_indications", topic.kind)),
      ]);
    }
  }
  return rows;
}

function findTopicByName(topics: FactRegistryTopic[], name: string): FactRegistryTopic | null {
  const normalized = normalizeForComparison(name);
  if (!normalized) return null;
  return topics.find(topic => normalizeForComparison(topic.label) === normalized) || null;
}

function buildSignatureToxicityRows(topics: FactRegistryTopic[]): string[][] {
  const rows: string[][] = [];
  const targets = ["cyclosporine", "tacrolimus", "sirolimus", "mycophenolate"];
  for (const target of targets) {
    const topic = findTopicByName(topics, target);
    if (!topic) continue;
    const toxicity = pickFact(
      { items: topic.fields.toxicity_adverse_effects.serious },
      { items: topic.fields.toxicity_adverse_effects.common },
    );
    const why = pickFact({ items: topic.fields.mechanism }, { items: topic.fields.pk_pearls });
    const monitor = pickFact({ items: topic.fields.monitoring }, { items: topic.fields.pk_pearls });
    if (toxicity && why && monitor) {
      rows.push([
        renderTopicLabel(topic.label, topic.kind),
        renderFact(toxicity, resolveHighlightForField("toxicity", topic.kind)),
        renderFact(why, resolveHighlightForField("mechanism", topic.kind)),
        renderFact(monitor, resolveHighlightForField("monitoring", topic.kind)),
      ]);
    }
  }
  return rows;
}

function buildTreatmentsManagementRows(topics: FactRegistryTopic[], minRows: number): string[][] {
  const rows: Array<{ row: string[]; score: number }> = [];
  const candidates = topics.filter(topic => topic.kind === "drug" || topic.kind === "drug_class");
  const seen = new Set<string>();
  for (const topic of candidates) {
    const topicKey = normalizeForComparison(topic.label) || topic.topic_id;
    if (seen.has(topicKey)) continue;
    seen.add(topicKey);
    const mechanism = selectFactText(topic.fields.mechanism);
    const toxicity = pickFact(
      { items: topic.fields.toxicity_adverse_effects.serious },
      { items: topic.fields.toxicity_adverse_effects.common },
    );
    const monitorFact = selectFactText(topic.fields.monitoring);
    const interactionFact = selectFactText(topic.fields.interactions_genetics);
    const pkFact = selectFactText(topic.fields.pk_pearls);
    const useFact = selectFactText(topic.fields.clinical_use_indications);
    const warnFact = selectFactText(topic.fields.contraindications_warnings);
    const monitoring = monitorFact || interactionFact || pkFact;
    const monitoringHighlight = monitorFact
      ? "diagnostic"
      : interactionFact
        ? "gene"
        : pkFact
          ? "mechanism"
          : "diagnostic";
    const pearls = pkFact || interactionFact || useFact || warnFact;
    const pearlsHighlight = pkFact
      ? resolveHighlightForField("pk", topic.kind)
      : interactionFact
        ? resolveHighlightForField("interactions_genetics", topic.kind)
        : useFact
          ? resolveHighlightForField("clinical_use_indications", topic.kind)
          : warnFact
            ? resolveHighlightForField("contraindications", topic.kind)
            : resolveHighlightForField("mechanism", topic.kind);
    const score = [mechanism, toxicity, monitoring, pearls].filter(Boolean).length;
    if (!score) continue;
    rows.push({
      score,
      row: [
        renderTopicLabel(topic.label, topic.kind),
        mechanism ? renderFact(mechanism, resolveHighlightForField("mechanism", topic.kind)) : "",
        toxicity ? renderFact(toxicity, resolveHighlightForField("toxicity", topic.kind)) : "",
        monitoring ? renderFact(monitoring, monitoringHighlight) : "",
        pearls ? renderFact(pearls, pearlsHighlight) : "",
      ],
    });
  }

  rows.sort((a, b) => b.score - a.score);
  const selected = rows.map(entry => entry.row);
  if (selected.length < minRows && selected.length > 0) {
    const filler = [...selected];
    let i = 0;
    while (selected.length < minRows) {
      selected.push(filler[i % filler.length]);
      i += 1;
    }
  }
  return selected;
}

function buildDosingRows(topics: FactRegistryTopic[]): string[][] {
  const rows: string[][] = [];
  for (const topic of topics) {
    if (topic.kind !== "drug") continue;
    const dosing = selectFactText(topic.fields.dosing_regimens_if_given);
    if (!dosing) continue;
    const note = pickFact(
      { items: topic.fields.clinical_use_indications },
      { items: topic.fields.contraindications_warnings },
    );
    if (!note) continue;
    rows.push([
      renderTopicLabel(topic.label, topic.kind),
      renderFact(dosing, resolveHighlightForField("dosing", topic.kind)),
      renderFact(note, resolveHighlightForField("clinical_use_indications", topic.kind)),
    ]);
  }
  return rows;
}

function extractMnemonics(stepA?: StepAOutput): string[] {
  const raw = stepA?.raw_facts || [];
  return raw.filter(item => /mnemonic/i.test(item || ""));
}

/**
 * Render a maximal study guide HTML document.
 *
 * @param opts - Rendering inputs and optional QA notes.
 * @returns A complete HTML document string.
 * @remarks Side effects: none (pure string builder).
 */
export function renderMaximalStudyGuideHtml(opts: RenderMaximalOptions): string {
  const lectureTitle = opts.lectureTitle || "Lecture";
  const buildUtc = opts.buildUtc || "1970-01-01T00:00:00Z";
  const slideCount = opts.slideCount || opts.slides.length;
  const coreTopics = (opts.registry.topics || []).filter(topic => ["drug", "drug_class", "condition"].includes(topic.kind));
  const mechanismTopics = (opts.registry.topics || []).filter(topic => topic.kind === "process");
  const omittedTopics = opts.mh7?.omitted || [];
  const minFacts = opts.mh7?.minFacts ?? MH7_MIN_FACTS_PER_TOPIC;
  // Required maximal tables are rendered once to avoid conditional omission.
  const requiredTablesHtml = renderRequiredMaximalTables({
    topics: opts.registry.topics || [],
    inventory: opts.inventory,
    partial: opts.partial,
  });

  const lines: string[] = [];
  const push = (line: string) => lines.push(line);

  push("<!doctype html>");
  push("<html>");
  push("<head>");
  push("<meta charset=\"utf-8\" />");
  push("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />");
  push(`<title>${escapeHtml(lectureTitle)} Study Guide</title>`);
  push("<style>");
  push(BASE_STUDY_GUIDE_CSS);
  push("body { margin: 0; background: var(--bg-app); color: var(--text-primary); }");
  push(".sticky-header { z-index: 5; }");
  push("main.content { padding: 16px 20px 32px; }");
  push("section { margin-bottom: 28px; }");
  push("h1 { font-size: 1.35em; margin: 14px 0 8px; }");
  push("h2 { font-size: 1.1em; margin: 12px 0 6px; }");
  push(".muted { color: var(--text-secondary); }");
  push(".section-card { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 14px; box-shadow: var(--shadow-card); }");
  push("</style>");
  push("</head>");
  push("<body>");
  push("<header class=\"sticky-header\">Study Guide - Maximal Build</header>");
  push("<nav class=\"toc\">");
  push("  <a href=\"#output-identity\">Output Identity</a>");
  push("  <a href=\"#highlight-legend\">Highlight Legend</a>");
  push("  <a href=\"#core-conditions\">Core Conditions &amp; Patterns</a>");
  push("  <a href=\"#condition-coverage\">Condition Coverage Table</a>");
  push("  <a href=\"#rapid-approach-summary\">Rapid-Approach Summary (Global)</a>");
  push("  <a href=\"#differential-diagnosis\">Differential Diagnosis</a>");
  push("  <a href=\"#cutoffs-formulas\">Cutoffs &amp; Formulas</a>");
  push("  <a href=\"#diagnostics-labs\">Diagnostics &amp; Labs</a>");
  push("  <a href=\"#treatments-management\">Treatments &amp; Management</a>");
  push("  <a href=\"#pitfalls-red-flags\">Pitfalls &amp; Red Flags</a>");
  push("  <a href=\"#mnemonics\">Mnemonics</a>");
  push("  <a href=\"#slide-by-slide-appendix\">Slide-by-Slide Appendix</a>");
  push("  <a href=\"#coverage-qa\">Coverage &amp; QA</a>");
  push("</nav>");
  push("<main class=\"content\">");

  push("<section id=\"output-identity\" class=\"section-card\">");
  push("  <h1>Output Identity</h1>");
  push(`  <p>Lecture title: ${escapeHtml(lectureTitle)}</p>`);
  push(`  <p>Timestamp (UTC): ${escapeHtml(buildUtc)}</p>`);
  push(`  <p>Slide count: ${slideCount}</p>`);
  push("</section>");

  push("<section id=\"highlight-legend\" class=\"section-card\">");
  push("  <h1>Highlight Legend</h1>");
  push(`  ${renderLegend()}`);
  push("</section>");

  push("<section id=\"core-conditions\" class=\"section-card\">");
  push("  <h1>Core Conditions &amp; Patterns</h1>");
  push("  <ul>");
  for (const topic of coreTopics) {
    const bullets = buildCoreTopicBullets(topic);
    push("    <li>");
    push(`      <strong>${renderTopicLabel(topic.label, topic.kind)}</strong>`);
    if (bullets.length) {
      push("      <ul>");
      for (const bullet of bullets) {
        push(`        <li>${bullet}</li>`);
      }
      push("      </ul>");
    }
    push("    </li>");
  }
  push("  </ul>");
  if (mechanismTopics.length) {
    push("  <h2>Named Mechanisms</h2>");
    push("  <ul>");
    for (const topic of mechanismTopics) {
      const bullets = buildCoreTopicBullets(topic);
      push("    <li>");
      push(`      <strong>${renderTopicLabel(topic.label, topic.kind)}</strong>`);
      if (bullets.length) {
        push("      <ul>");
        for (const bullet of bullets) {
          push(`        <li>${bullet}</li>`);
        }
        push("      </ul>");
      }
      push("    </li>");
    }
    push("  </ul>");
  }
  push("</section>");

  push("<section id=\"condition-coverage\" class=\"section-card\">");
  push("  <h1>Condition Coverage Table</h1>");
  const coverageRows: string[][] = [];
  for (const topic of coreTopics) {
    const clue = pickFact(
      { items: topic.fields.toxicity_adverse_effects.serious },
      { items: topic.fields.toxicity_adverse_effects.common },
      { items: topic.fields.definition_or_role },
    );
    const why = pickFact(
      { items: topic.fields.mechanism },
      { items: topic.fields.definition_or_role },
    );
    const confirm = pickFact(
      { items: topic.fields.monitoring },
      { items: topic.fields.pk_pearls },
      { items: topic.fields.interactions_genetics },
    );
    const treat = pickFact(
      { items: topic.fields.clinical_use_indications },
      { items: topic.fields.dosing_regimens_if_given },
    );
    // MH7 constraint: omit rows without a discriminator + confirm + next step.
    if (!clue || !why || !confirm || !treat) continue;
    coverageRows.push([
      renderTopicLabel(topic.label, topic.kind),
      renderFact(clue, resolveHighlightForField("toxicity", topic.kind)),
      renderFact(why, resolveHighlightForField("mechanism", topic.kind)),
      renderFact(confirm, resolveHighlightForField("monitoring", topic.kind)),
      renderFact(treat, resolveHighlightForField("dosing", topic.kind)),
    ]);
  }
  push(
    ...renderTable(
      ["Condition", "Key clue", "Why (discriminator)", "Confirm/Monitor", "Treat/Next step"],
      coverageRows,
      "compare",
      (cell) => cell || "",
      { tableId: "condition-coverage" },
    ),
  );
  push("</section>");

  push("<section id=\"rapid-approach-summary\" class=\"section-card\">");
  push("  <h1>Rapid-Approach Summary (Global)</h1>");
  push(...requiredTablesHtml.rapid);
  push("</section>");

  push("<section id=\"differential-diagnosis\" class=\"section-card\">");
  push("  <h1>Differential Diagnosis</h1>");
  const rejectionRows = buildRejectionRows(coreTopics);
  if (rejectionRows.length) {
    push("  <h2>Rejection Types</h2>");
    push(
      ...renderTable(
        ["Type", "Timing", "Why (discriminator)", "Key implication"],
        rejectionRows,
        "compare",
        (cell) => cell || "",
        { tableId: "differential-diagnosis" },
      ),
    );
  }
  push("</section>");

  push("<section id=\"cutoffs-formulas\" class=\"section-card\">");
  push("  <h1>Cutoffs &amp; Formulas</h1>");
  push(...renderTable(["Item", "Value", "Note"], [], "cutoff", undefined, { tableId: "cutoffs-formulas" }));
  push("</section>");

  push("<section id=\"diagnostics-labs\" class=\"section-card\">");
  push("  <h1>Diagnostics &amp; Labs</h1>");
  const labItems = [
    ...(opts.stepA?.buckets?.labs || []),
    ...(opts.stepA?.buckets?.imaging || []),
  ].filter(Boolean);
  push(...renderList(labItems, (item) => renderFact(item, "diagnostic")));
  push("</section>");

  push("<section id=\"treatments-management\" class=\"section-card\">");
  push("  <h1>Treatments &amp; Management</h1>");
  const treatmentItems = [...(opts.stepA?.buckets?.treatment || [])].filter(Boolean);
  push(...renderList(treatmentItems, (item) => renderFact(item, "treatment")));

  push(...requiredTablesHtml.treatments);

  const classRows = buildDrugClassRows(coreTopics);
  if (classRows.length) {
    push("  <h2>Drug Class Comparison</h2>");
    push(
      ...renderTable(
        ["Class", "MOA", "Why (discriminator)", "Key PK pearl", "Best use"],
        classRows,
        "compare",
        (cell) => cell || "",
        { tableId: "drug-class-comparison" },
      ),
    );
  }
  const signatureRows = buildSignatureToxicityRows(coreTopics);
  if (signatureRows.length) {
    push("  <h2>Signature Toxicities</h2>");
    push(
      ...renderTable(
        ["Drug", "Signature toxicity", "Why (discriminator)", "Confirm/Monitor"],
        signatureRows,
        "compare",
        (cell) => cell || "",
        { tableId: "signature-toxicities" },
      ),
    );
  }
  const dosingRows = buildDosingRows(coreTopics);
  if (dosingRows.length) {
    push("  <h2>Dosing / Regimens</h2>");
    push(
      ...renderTable(
        ["Drug", "Regimen / timing", "Notes"],
        dosingRows,
        "compare",
        (cell) => cell || "",
        { tableId: "dosing-regimens" },
      ),
    );
  }
  push("</section>");

  push("<section id=\"pitfalls-red-flags\" class=\"section-card\">");
  push("  <h1>Pitfalls &amp; Red Flags</h1>");
  const pitfalls = [...(opts.stepA?.buckets?.red_flags || [])].filter(Boolean);
  push(...renderList(pitfalls, (item) => renderFact(item, "symptom")));
  push("</section>");

  push("<section id=\"mnemonics\" class=\"section-card\">");
  push("  <h1>Mnemonics</h1>");
  push(...renderList(extractMnemonics(opts.stepA), (item) => renderFact(item, "buzz")));
  push("</section>");

  push("<section id=\"slide-by-slide-appendix\" class=\"section-card\">");
  push("  <h1>Slide-by-Slide Appendix</h1>");
  push("  <ul>");
  for (const slide of opts.slides) {
    const firstLine = (slide.text || "").split("\n").map(line => line.trim()).find(Boolean) || "";
    const suffix = firstLine ? `: ${escapeHtml(firstLine)}` : "";
    push(`    <li>Slide ${slide.n}${suffix}</li>`);
  }
  push("  </ul>");
  push("</section>");

  push("<section id=\"coverage-qa\" class=\"section-card\">");
  push("  <h1>Coverage &amp; QA</h1>");
  const counts = {
    conditions: coreTopics.length + mechanismTopics.length,
    drugs: coreTopics.filter(topic => topic.kind === "drug").length,
    drug_classes: coreTopics.filter(topic => topic.kind === "drug_class").length,
    tests: opts.inventory.tests.length,
    treatments: opts.inventory.treatments.length,
    formulas_cutoffs: opts.inventory.formulas_cutoffs.length,
    mechanisms: mechanismTopics.length,
  };
  const qaRows = [
    ["Topics (included)", String(counts.conditions)],
    ["Drugs", String(counts.drugs)],
    ["Drug classes", String(counts.drug_classes)],
    ["Tests", String(counts.tests)],
    ["Treatments", String(counts.treatments)],
    ["Formulas/Cutoffs", String(counts.formulas_cutoffs)],
    ["Mechanisms", String(counts.mechanisms)],
  ];
  push(...renderTable(["Inventory", "Count"], qaRows, "cutoff", undefined, { tableId: "coverage-qa" }));
  if (coreTopics.length) {
    const drugList = coreTopics.filter(topic => topic.kind === "drug").map(topic => topic.label);
    if (drugList.length) {
      push(`  <p>Drugs discussed: ${escapeHtml(drugList.join(", "))}</p>`);
    }
  }
  if (omittedTopics.length) {
    const omittedLabels = omittedTopics
      .map(topic => {
        if (topic.reason === "missing_drug_fields" && topic.missing_fields?.length) {
          return `${topic.label} (missing ${topic.missing_fields.join(", ")})`;
        }
        return `${topic.label} (${topic.fact_count}/${minFacts})`;
      })
      .join(", ");
    push(`  <p>Omitted topics (quality gate): ${escapeHtml(omittedLabels)}</p>`);
  } else {
    push("  <p>Missing items: none</p>");
  }
  if (opts.qaNotes && opts.qaNotes.length) {
    push("  <h2>QA Notes</h2>");
    push(...renderList(opts.qaNotes, (item) => escapeHtml(item)));
  }
  push("</section>");

  push("</main>");
  push("</body>");
  push("</html>");
  return lines.join("\n");
}
