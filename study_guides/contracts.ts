/**
 * Style contracts and CSS primitives for study guide rendering/validation.
 *
 * Used by: `render_maximal_html.ts`, `validate.runtime.ts`, and
 * `machine/render_study_guide_html.ts` to enforce consistent styles.
 *
 * Key exports:
 * - Highlight categories, required class lists, and CSS snippets.
 * - `renderLegend` / `renderStyleBlock` helpers for HTML output.
 *
 * Assumptions:
 * - CSS strings are embedded directly into rendered HTML documents.
 */
export type HighlightCategory =
  | "disease"
  | "symptom"
  | "histology"
  | "treatment"
  | "diagnostic"
  | "gene"
  | "enzyme"
  | "buzz"
  | "cutoff"
  | "mechanism";

/**
 * Legend entries for each highlight category rendered in the study guide.
 */
export const HIGHLIGHT_LEGEND_ITEMS: Array<{ label: string; className: HighlightCategory }> = [
  { label: "Disease", className: "disease" },
  { label: "Symptom", className: "symptom" },
  { label: "Histology", className: "histology" },
  { label: "Treatment", className: "treatment" },
  { label: "Diagnostic", className: "diagnostic" },
  { label: "Gene", className: "gene" },
  { label: "Enzyme", className: "enzyme" },
  { label: "Buzz", className: "buzz" },
  { label: "Cutoff", className: "cutoff" },
  { label: "Mechanism", className: "mechanism" },
];

/**
 * Required CSS classes that the HTML renderer must emit for validation.
 */
export const REQUIRED_HIGHLIGHT_CLASSES = [
  "hl disease",
  "hl symptom",
  "hl diagnostic",
  "hl treatment",
  "hl cutoff",
  "hl mechanism",
  "hl buzz",
  "hl histology",
  "hl gene",
  "hl enzyme",
] as const;

/**
 * Required table class names used by validators and renderers.
 */
export const REQUIRED_TABLE_CLASSNAMES = ["tri", "compare", "cutoff"] as const;

/**
 * Canonical style contract used to validate highlight classes and tables.
 */
export const CANONICAL_STYLE_CONTRACT = {
  requiredHighlightClasses: REQUIRED_HIGHLIGHT_CLASSES,
  requiredLegendItems: HIGHLIGHT_LEGEND_ITEMS,
  requiredTableClassNames: REQUIRED_TABLE_CLASSNAMES,
};

/**
 * Selectors used to locate maximal coverage sections in rendered HTML.
 */
export const MAXIMAL_COVERAGE_CONTRACT = {
  appendixSelectors: ["#slide-by-slide-appendix", "#appendix", ".appendix"],
};

/**
 * Base CSS string injected into study guide HTML outputs.
 */
export const BASE_STUDY_GUIDE_CSS = String.raw`:root { color-scheme: light; --bg-app: #F6F1E8; --bg-app-2: #F2EDE3; --bg-surface: #FBF7F0; --bg-surface-alt: #F2EDE3; --bg-surface-hover: #FDF8F1; --text-primary: #1F1B16; --text-secondary: #5F584F; --text-muted: #726A60; --border-subtle: #E3D9CC; --shadow-soft: 0 6px 22px rgba(0, 0, 0, 0.06); --shadow-card: 0 10px 30px rgba(0, 0, 0, 0.06); --shadow-focus: 0 0 0 2px rgba(90, 170, 160, 0.16); }
body { font-family: Arial, sans-serif; line-height: 1.5; background: var(--bg-app); color: var(--text-primary); }
.sticky-header { position: sticky; top: 0; background: var(--bg-surface-alt); padding: 8px; font-size: 1.2em; font-weight: bold; text-align: center; border-bottom: 1px solid var(--border-subtle); }
nav.toc { position: fixed; top: 0; left: 0; width: 220px; height: 100%; overflow: auto; background: var(--bg-surface-alt); border-right: 1px solid var(--border-subtle); padding: 6px; }
nav.toc a { text-decoration: none; display: block; margin: 4px 0; font-size: 0.9em; }
main.content { margin-left: 230px; padding: 10px; }
.chip { display: inline-block; padding: 2px 6px; margin: 0 4px; border-radius: 4px; font-size: 0.85em; font-weight: bold; color: var(--bg-surface-hover); }
.chip.labs { background: #17a2b8; }
.chip.hi { background: #6f42c1; }
.chip.danger { background: #dc3545; }
/* .chip.supplemental DISABLED in canonical builds */

.scrollable { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; }
th, td { border: 1px solid var(--border-subtle); padding: 4px 8px; text-align: left; vertical-align: top; }
th { background: var(--bg-surface-alt); position: sticky; top: 0; }
details { margin: 8px 0; }
summary { font-weight: bold; cursor: pointer; }

/* ======= Highlights (GLOBAL COLOR-CODING) -- exact ======= */
.hl { padding: 0 4px; border-radius: 4px; font-weight: 600; box-decoration-break: clone; }
.hl.disease   { background:#f8d7da; color:#7f1d1d; border-bottom:2px solid #f1aeb5; }
.hl.symptom   { background:#fff3cd; color:#664d03; border-bottom:2px solid #ffe08a; }
.hl.histology { background:#dbeafe; color:#0c4a6e; border-bottom:2px solid #a5d8ff; }
.hl.treatment { background:#d1e7dd; color:#0f5132; border-bottom:2px solid #95d5b2; }
.hl.diagnostic{ background:#e7dbff; color:#3f1d7a; border-bottom:2px solid #c9b6ff; }
.hl.gene      { background:#fde2ef; color:#7a284b; border-bottom:2px solid #f3a6c6; }
.hl.enzyme    { background:#ffe8d6; color:#7a3f00; border-bottom:2px solid #ffc078; }
.hl.buzz      { background:#efe2d1; color:#5a3821; border-bottom:2px solid #d2b48c; }
.hl.cutoff    { background:#d9f2f2; color:#0b4f4f; border-bottom:2px solid #a7e0e0; }
.hl.mechanism { background:#dbeafe; color:#0c4a6e; border-bottom:2px solid #a5d8ff; }

.legend { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 2px; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.85em; font-weight: 700; border: 1px solid var(--border-subtle); }
.pill.disease   { background:#f8d7da; color:#7f1d1d; }
.pill.symptom   { background:#fff3cd; color:#664d03; }
.pill.histology { background:#dbeafe; color:#0c4a6e; }
.pill.treatment { background:#d1e7dd; color:#0f5132; }
.pill.diagnostic{ background:#e7dbff; color:#3f1d7a; }
.pill.gene      { background:#fde2ef; color:#7a284b; }
.pill.enzyme    { background:#ffe8d6; color:#7a3f00; }
.pill.buzz      { background:#efe2d1; color:#5a3821; }
.pill.cutoff    { background:#d9f2f2; color:#0b4f4f; }
.pill.mechanism { background:#dbeafe; color:#0c4a6e; }

table.tri { border-collapse: collapse; width: 100%; margin: 10px 0; }
table.tri thead th:nth-child(1) { background:#ffe9a8; }
table.tri thead th:nth-child(2) { background:#b8daff; }
table.tri thead th:nth-child(3) { background:#e8f3ef; }
table.tri tbody td:nth-child(1) { background:#fffaf0; }
table.tri tbody td:nth-child(2) { background:#f2f8ff; }
table.tri tbody td:nth-child(3) { background:#f7fbf9; }
table.tri thead th { position: sticky; top: 0; }
table.tri tbody tr:nth-child(even) td { filter: brightness(0.995); }

table.compare thead th { background: var(--bg-surface-alt); }
table.cutoff thead th { background: var(--bg-surface-alt); }

@media print { .hl { box-shadow: inset 0 -1px 0 rgba(0,0,0,0.2); } }
`;

/**
 * Render the highlight legend as HTML.
 *
 * @returns HTML string for the legend block.
 */
export function renderLegend(): string {
  const lines = ["<div class=\"legend\">"];
  for (const item of HIGHLIGHT_LEGEND_ITEMS) {
    lines.push(`  <span class=\"pill ${item.className}\">${item.label}</span>`);
  }
  lines.push("</div>");
  return lines.join("\n");
}

/**
 * Render a `<style>` tag containing base CSS plus optional overrides.
 *
 * @param extraCss - Optional additional CSS rules appended after the base.
 * @returns HTML `<style>` block string.
 */
export function renderStyleBlock(extraCss?: string): string {
  const trimmedExtra = (extraCss || "").trim();
  const extra = trimmedExtra ? `\n${trimmedExtra}` : "";
  return `<style>\n${BASE_STUDY_GUIDE_CSS}${extra}\n</style>`;
}
