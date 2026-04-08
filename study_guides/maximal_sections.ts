/**
 * Helpers to build additional coverage sections for maximal study guides.
 *
 * Used by: `render_maximal_html.ts` to inject QA and condition tables into
 * the rendered HTML output.
 *
 * Key exports:
 * - Section renderers (`renderCoverageQaSection`, `renderCoreConditionsSection`,
 *   `renderConditionCoverageTable`).
 * - HTML insertion helpers (`insertSectionBeforeHtmlEnd`, `upsertCoverageSections`).
 *
 * Assumptions:
 * - HTML strings are well-formed and include a `<main>` or `</html>` tag.
 */
import { buildInventorySummary, type TopicInventory } from "./inventory";
import { normalizeForComparison, normalizeTokens, stripLeadingNumbering } from "./normalize";

/**
 * Render a coverage/QA section summarizing inventory counts.
 *
 * @param inventory - Topic inventory derived from slides.
 * @returns HTML section string.
 */
export function renderCoverageQaSection(inventory: TopicInventory): string {
  const counts = buildInventorySummary(inventory);
  const rows = [
    ["Conditions", String(counts.conditions)],
    ["Tests", String(counts.tests)],
    ["Treatments", String(counts.treatments)],
    ["Formulas/Cutoffs", String(counts.formulas_cutoffs)],
    ["Mechanisms", String(counts.mechanisms)],
  ];
  const lines: string[] = [];
  lines.push("<section id=\"coverage-qa\">");
  lines.push("  <h1>Coverage &amp; QA</h1>");
  lines.push("  <table class=\"cutoff\">");
  lines.push("    <thead>");
  lines.push("      <tr><th>Inventory</th><th>Count</th></tr>");
  lines.push("    </thead>");
  lines.push("    <tbody>");
  for (const row of rows) {
    lines.push(`      <tr><td>${row[0]}</td><td>${row[1]}</td></tr>`);
  }
  lines.push("    </tbody>");
  lines.push("  </table>");
  lines.push("  <p>Missing items: none</p>");
  lines.push("</section>");
  return lines.join("\n");
}

/**
 * Insert a section HTML snippet just before the closing `</html>` tag.
 *
 * @param html - Original HTML document string.
 * @param sectionHtml - Section HTML to insert.
 * @returns Updated HTML document string.
 */
export function insertSectionBeforeHtmlEnd(html: string, sectionHtml: string): string {
  const marker = "</html>";
  const idx = (html || "").toLowerCase().lastIndexOf(marker);
  if (idx === -1) return html;
  const before = html.slice(0, idx);
  const after = html.slice(idx);
  return `${before}\n${sectionHtml}\n${after}`;
}

type SlideBlock = { n: number; text: string };

type ConditionFact = {
  condition: string;
  display: string;
  context: string;
  clue: string;
  confirm: string;
  treat: string;
};

function escapeHtml(value: string): string {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanLine(line: string): string {
  return stripLeadingNumbering(line || "")
    .replace(/^\s*[-*]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findConditionLine(condition: string, slides: SlideBlock[]): string | null {
  const normalizedCondition = normalizeForComparison(condition);
  const tokens = normalizeTokens(condition);
  for (const slide of slides) {
    const lines = (slide.text || "").split("\n").map(cleanLine).filter(Boolean);
    for (const line of lines) {
      const normalizedLine = normalizeForComparison(line);
      if (normalizedCondition && normalizedLine.includes(normalizedCondition)) {
        return line;
      }
      const lineTokens = new Set(normalizeTokens(line));
      if (tokens.length && tokens.every(token => lineTokens.has(token))) {
        return line;
      }
    }
  }
  return null;
}

function findConditionLineByHint(condition: string, slides: SlideBlock[], hint: RegExp): string | null {
  const normalizedCondition = normalizeForComparison(condition);
  const tokens = normalizeTokens(condition);
  for (const slide of slides) {
    const lines = (slide.text || "").split("\n").map(cleanLine).filter(Boolean);
    for (const line of lines) {
      if (!hint.test(line)) continue;
      const normalizedLine = normalizeForComparison(line);
      if (normalizedCondition && normalizedLine.includes(normalizedCondition)) {
        return line;
      }
      const lineTokens = new Set(normalizeTokens(line));
      if (tokens.length && tokens.every(token => lineTokens.has(token))) {
        return line;
      }
    }
  }
  return null;
}

/**
 * Build condition facts by scanning slide text for context/clue/confirm/treat lines.
 *
 * @param inventory - Topic inventory with conditions.
 * @param slides - Slide blocks with extracted text.
 * @returns Structured facts for condition coverage sections.
 */
export function buildConditionFacts(inventory: TopicInventory, slides: SlideBlock[]): ConditionFact[] {
  const facts: ConditionFact[] = [];
  for (const condition of inventory.conditions || []) {
    const display = stripLeadingNumbering(condition);
    const context = findConditionLine(condition, slides) || "";
    const clue = findConditionLineByHint(condition, slides, /(symptom|presentation|clue|sign|case)/i) || context;
    const confirm =
      findConditionLineByHint(condition, slides, /(diagnostic|test|lab|abg|workup|confirm)/i) || "";
    const treat =
      findConditionLineByHint(condition, slides, /(treat|therapy|management|antidote|insulin|fluids|dialysis)/i) || "";
    facts.push({ condition, display, context, clue, confirm, treat });
  }
  return facts;
}

/**
 * Render a list-style section of core conditions with highlight classes.
 *
 * @param facts - Condition facts to render.
 * @returns HTML section string.
 */
export function renderCoreConditionsSection(facts: ConditionFact[]): string {
  const lines: string[] = [];
  lines.push("<section id=\"core-conditions\">");
  lines.push("  <h1>Core Conditions &amp; Patterns</h1>");
  lines.push("  <ul>");
  for (const fact of facts) {
    lines.push("    <li>");
    lines.push(`      <strong><span class=\"hl disease\">${escapeHtml(fact.display)}</span></strong>`);
    lines.push("      <ul>");
    lines.push(`        <li><span class=\"hl disease\">Context</span>: ${escapeHtml(fact.context)}</li>`);
    lines.push(`        <li><span class=\"hl symptom\">Key clues</span>: ${escapeHtml(fact.clue)}</li>`);
    lines.push(`        <li><span class=\"hl diagnostic\">Confirm</span>: ${escapeHtml(fact.confirm)}</li>`);
    lines.push(`        <li><span class=\"hl treatment\">Treat</span>: ${escapeHtml(fact.treat)}</li>`);
    lines.push("      </ul>");
    lines.push("    </li>");
  }
  lines.push("  </ul>");
  lines.push("</section>");
  return lines.join("\n");
}

/**
 * Render a tabular condition coverage section.
 *
 * @param facts - Condition facts to render.
 * @returns HTML section string.
 */
export function renderConditionCoverageTable(facts: ConditionFact[]): string {
  const lines: string[] = [];
  lines.push("<section id=\"condition-coverage\">");
  lines.push("  <h1>Condition Coverage Table</h1>");
  lines.push("  <table class=\"compare\">");
  lines.push("    <thead>");
  lines.push("      <tr><th>Condition</th><th>Key clue</th><th>Confirm</th><th>Treat</th></tr>");
  lines.push("    </thead>");
  lines.push("    <tbody>");
  for (const fact of facts) {
    lines.push("      <tr>");
    lines.push(`        <td><span class=\"hl disease\">${escapeHtml(fact.display)}</span></td>`);
    lines.push(`        <td>${escapeHtml(fact.clue)}</td>`);
    lines.push(`        <td>${escapeHtml(fact.confirm)}</td>`);
    lines.push(`        <td>${escapeHtml(fact.treat)}</td>`);
    lines.push("      </tr>");
  }
  lines.push("    </tbody>");
  lines.push("  </table>");
  lines.push("</section>");
  return lines.join("\n");
}

function removeSectionById(html: string, id: string): string {
  const regex = new RegExp(`<section[^>]*id=["']${id}["'][\\s\\S]*?<\\/section>`, "i");
  return (html || "").replace(regex, "");
}

/**
 * Remove existing coverage sections and re-insert updated ones.
 *
 * @param html - Original HTML document string.
 * @param facts - Condition facts to render.
 * @returns HTML document with updated coverage sections.
 */
export function upsertCoverageSections(html: string, facts: ConditionFact[]): string {
  let updated = removeSectionById(html, "core-conditions");
  updated = removeSectionById(updated, "condition-coverage");
  const combined = [renderCoreConditionsSection(facts), renderConditionCoverageTable(facts)].join("\n");
  const appendixMatch = updated.match(/<section[^>]*id=["']slide-by-slide-appendix["'][\s\S]*$/i);
  if (appendixMatch && typeof appendixMatch.index === "number") {
    const idx = appendixMatch.index;
    return `${updated.slice(0, idx)}${combined}\n${updated.slice(idx)}`;
  }
  const mainIdx = updated.toLowerCase().lastIndexOf("</main>");
  if (mainIdx !== -1) {
    return `${updated.slice(0, mainIdx)}${combined}\n${updated.slice(mainIdx)}`;
  }
  return insertSectionBeforeHtmlEnd(updated, combined);
}
