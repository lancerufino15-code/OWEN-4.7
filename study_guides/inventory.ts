/**
 * Topic inventory extraction from slide text.
 *
 * Used by: study guide pipeline in `src/index.ts` and validators to classify
 * lecture topics and build summary counts.
 *
 * Key exports:
 * - `TopicKind` / `TopicInventory`: classification enums and bucket shapes.
 * - `isGarbageTopicLabel`, `classifyTopicLabel`: label heuristics.
 * - `extractTopicInventoryFromSlides`: main inventory builder.
 * - `buildInventorySummary`: compact counts for analytics/QA.
 *
 * Assumptions:
 * - Input slide text is pre-cleaned (no code blocks, minimal OCR noise).
 */
import { normalizeForComparison, stripLeadingNumbering } from "./normalize";

/**
 * High-level topic classification used for study guide routing.
 */
export type TopicKind = "drug" | "drug_class" | "condition" | "process" | "garbage";

/**
 * Bucketed topic lists derived from slide text.
 */
export type TopicInventory = {
  conditions: string[];
  drugs: string[];
  drug_classes: string[];
  phenotypes: string[];
  processes: string[];
  garbage: string[];
  tests: string[];
  treatments: string[];
  formulas_cutoffs: string[];
  mechanisms: string[];
};

type InventoryCategory = "tests" | "treatments" | "formulas_cutoffs" | "mechanisms";

const HEADING_SUFFIXES = [
  /overview$/i,
  /causes?$/i,
  /differential diagnosis$/i,
  /differential$/i,
  /diagnosis$/i,
  /classification$/i,
  /pathophysiology$/i,
  /pathophys$/i,
  /presentation$/i,
  /management$/i,
  /treatment$/i,
  /practice quiz.*$/i,
  /case.*$/i,
  /learning objectives$/i,
  /introduction.*$/i,
];

const HEADING_PREFIXES = [
  /^practice quiz\s*[-:]\s*/i,
  /^case\s*\d*\s*[-:]\s*/i,
  /^slide\s*\d+\s*[-:]\s*/i,
];

const MECHANISM_HINTS = /(mechanism|pathophys|pathophysiology|compensation|buffer|regulation|axis|pathway|signal|signaling)/i;
const TEST_HINTS = /(diagnosis|diagnostic|test|lab|abg|pco2|hco3|ph|anion gap|imaging|workup)/i;
const TREATMENT_HINTS = /(treatment|therapy|management|antidote|insulin|fluids|dialysis)/i;
const FORMULA_HINTS = /(formula|equation|calculation|cutoff|ratio|gap|delta|winter|normal range)/i;

const GENERIC_HEADING_HINT = /(syndrome|disease|disorder|acidosis|alkalosis|toxicity|overdose|rta|tubular|hyper|hypo|rejection|gvhd)/i;

const GARBAGE_PATTERNS = [
  /'''|```/i,
  /\bplaintext\b/i,
  /\bobjectives?\b/i,
  /\bsummary\b/i,
  /\boverview\b/i,
  /\bintroduction\b/i,
  /\btimeline\b/i,
  /\bagenda\b/i,
  /\boutline\b/i,
  /\btable of contents\b/i,
  /\blearning objectives\b/i,
  /\bdisclosure\b/i,
  /\bconflict(s)? of interest\b/i,
  /\breferences?\b/i,
  /\backnowledg/i,
  /\bappendix\b/i,
  /^mechanism(s)?$/i,
  /^pathway(s)?$/i,
  /^signal(ing)?$/i,
  /^axis(es)?$/i,
  /\bslide\s*\d+\b/i,
  /\bmanagement of\b/i,
  /\btreatment of\b/i,
  /\bdiagnosis of\b/i,
  /\bworkup of\b/i,
  /\bpathophysiology of\b/i,
  /\bmechanism of\b/i,
  /\bapproach to\b/i,
  /\bcase study\b/i,
  /\bcase presentation\b/i,
  /\bkey points\b/i,
  /—\s*end\s*—/i,
  /--\s*end\s*--/i,
  /\bend\b\s*$/i,
];

const SPEAKER_HINTS = [
  /\b(md|do|phd|mph|msc|mba|rn|np|pa)\b/i,
  /\bprofessor\b/i,
  /\bdepartment\b/i,
  /\buniversity\b/i,
  /\bhospital\b/i,
  /\bmedical center\b/i,
];

const DRUG_CLASS_HINTS =
  /(inhibitors?|blockers?|antagonists?|agonists?|antimetabolites?|immunosuppressants?|steroids?|antibodies?|analogs?|co-?stim(ulation)? blockers?|calcineurin|mTOR|IL-2R)/i;

const DRUG_SUFFIXES = [
  "mab",
  "nib",
  "tinib",
  "statin",
  "pril",
  "sartan",
  "olol",
  "prazole",
  "azole",
  "cillin",
  "caine",
  "vir",
  "avir",
  "vudine",
  "mycin",
  "floxacin",
  "tacrolimus",
  "porine",
  "imus",
  "cept",
  "azine",
];

const DRUG_EXACT_MATCHES = new Set([
  "tacrolimus",
  "cyclosporine",
  "sirolimus",
  "everolimus",
  "mycophenolate",
  "mycophenolate mofetil",
  "basiliximab",
  "belatacept",
  "alemtuzumab",
  "rATG",
  "antithymocyte globulin",
  "prednisone",
  "prednisolone",
  "methylprednisolone",
]);

const cleanWhitespace = (value: string) => (value || "").replace(/\s+/g, " ").trim();

function normalizeTopicLine(line: string): string {
  let cleaned = cleanWhitespace(stripLeadingNumbering(line));
  for (const prefix of HEADING_PREFIXES) {
    cleaned = cleaned.replace(prefix, "");
  }
  for (const suffix of HEADING_SUFFIXES) {
    cleaned = cleaned.replace(suffix, "");
  }
  cleaned = cleaned.replace(/\s*[-:]\s*$/, "");
  return cleanWhitespace(cleaned);
}

function classifyInventoryCategory(label: string): InventoryCategory | null {
  if (FORMULA_HINTS.test(label)) return "formulas_cutoffs";
  if (TEST_HINTS.test(label)) return "tests";
  if (TREATMENT_HINTS.test(label)) return "treatments";
  if (MECHANISM_HINTS.test(label)) return "mechanisms";
  return null;
}

function looksLikeDrug(label: string): boolean {
  const cleaned = cleanWhitespace(label).toLowerCase();
  if (!cleaned) return false;
  if (DRUG_EXACT_MATCHES.has(cleaned)) return true;
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length > 3) return false;
  return words.some(word => DRUG_SUFFIXES.some(suffix => word.endsWith(suffix)));
}

function looksLikeDrugClass(label: string): boolean {
  return DRUG_CLASS_HINTS.test(label);
}

function looksLikeProcess(label: string): boolean {
  if (/->|→/.test(label)) return true;
  if (MECHANISM_HINTS.test(label)) {
    const tokens = normalizeForComparison(label).split(" ").filter(Boolean);
    if (tokens.length >= 3) return true;
    if (tokens.length >= 2 && /(axis|pathway|signal|signaling)/i.test(label)) return true;
    return false;
  }
  return false;
}

function looksLikeCondition(label: string): boolean {
  return GENERIC_HEADING_HINT.test(label) || /(rejection|gvhd|syndrome|disease|disorder)/i.test(label);
}

/**
 * Heuristic check for labels that should be ignored as non-topics.
 *
 * @param label - Raw heading or line text.
 * @returns True if the label looks like boilerplate or noise.
 */
export function isGarbageTopicLabel(label: string): boolean {
  const trimmed = cleanWhitespace(label);
  if (!trimmed) return true;
  if (trimmed.length > 140) return true;
  if (/^[-*]+\s*$/.test(trimmed)) return true;
  if (/^\d+$/.test(trimmed)) return true;
  for (const pattern of GARBAGE_PATTERNS) {
    if (pattern.test(trimmed)) {
      if (/->|→/.test(trimmed)) return false;
      if (/axis|pathway|signal|signaling/i.test(trimmed)) {
        const tokens = normalizeForComparison(trimmed).split(" ").filter(Boolean);
        if (tokens.length >= 2) return false;
      }
      return true;
    }
  }
  for (const pattern of SPEAKER_HINTS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

/**
 * Classify a candidate label into a topic kind bucket.
 *
 * @param label - Candidate label (already normalized).
 * @returns Topic kind classification.
 */
export function classifyTopicLabel(label: string): TopicKind {
  if (isGarbageTopicLabel(label)) return "garbage";
  if (looksLikeDrugClass(label)) return "drug_class";
  if (looksLikeDrug(label)) return "drug";
  if (looksLikeProcess(label)) return "process";
  if (looksLikeCondition(label)) return "condition";
  return "condition";
}

function shouldConsiderLine(line: string): boolean {
  const trimmed = cleanWhitespace(line);
  if (!trimmed) return false;
  if (trimmed.length > 140) return false;
  if (/^[-*]+\s*$/.test(trimmed)) return false;
  if (/^\d+$/.test(trimmed)) return false;
  return true;
}

function collectSlideLines(text: string): string[] {
  const lines: string[] = [];
  let inCodeBlock = false;
  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (/```|'''/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    if (!shouldConsiderLine(line)) continue;
    lines.push(line);
  }
  return lines;
}

/**
 * Extract a topic inventory from slide text.
 *
 * @param slides - Slide list with slide number and text content.
 * @returns Bucketed inventory of topics, drugs, and related labels.
 */
export function extractTopicInventoryFromSlides(slides: Array<{ n: number; text: string }>): TopicInventory {
  const inventory: TopicInventory = {
    conditions: [],
    drugs: [],
    drug_classes: [],
    phenotypes: [],
    processes: [],
    garbage: [],
    tests: [],
    treatments: [],
    formulas_cutoffs: [],
    mechanisms: [],
  };

  const seen = new Map<keyof TopicInventory, Set<string>>(
    Object.keys(inventory).map(key => [key as keyof TopicInventory, new Set<string>()]),
  );

  const addItem = (category: keyof TopicInventory, value: string) => {
    const cleaned = cleanWhitespace(value);
    if (!cleaned) return;
    const key = normalizeForComparison(cleaned) || cleaned.toLowerCase();
    const bucket = seen.get(category);
    if (!bucket || bucket.has(key)) return;
    bucket.add(key);
    inventory[category].push(cleaned);
  };

  const addCoreTopic = (kind: TopicKind, value: string) => {
    if (kind === "drug") {
      addItem("drugs", value);
      addItem("conditions", value);
    } else if (kind === "drug_class") {
      addItem("drug_classes", value);
      addItem("conditions", value);
    } else if (kind === "condition") {
      addItem("phenotypes", value);
      addItem("conditions", value);
    } else if (kind === "process") {
      addItem("processes", value);
      addItem("mechanisms", value);
    } else if (kind === "garbage") {
      addItem("garbage", value);
    }
  };

  for (const slide of slides || []) {
    const lines = collectSlideLines(slide?.text || "");
    if (!lines.length) continue;

    const candidates: string[] = [];
    if (lines[0]) candidates.push(lines[0]);
    for (const line of lines.slice(1, 10)) {
      if (
        GENERIC_HEADING_HINT.test(line) ||
        looksLikeDrug(line) ||
        looksLikeDrugClass(line) ||
        looksLikeProcess(line)
      ) {
        candidates.push(line);
      }
    }

    for (const raw of candidates) {
      const normalized = normalizeTopicLine(raw);
      if (!normalized) continue;
      const kind = classifyTopicLabel(normalized);
      addCoreTopic(kind, normalized);
      const category = classifyInventoryCategory(normalized);
      if (category) addItem(category, normalized);
    }
  }

  return inventory;
}

/**
 * Summarize key inventory counts for reporting/analytics.
 *
 * @param inventory - Full topic inventory.
 * @returns Object with per-bucket counts.
 */
export function buildInventorySummary(inventory: TopicInventory) {
  return {
    conditions: inventory.conditions.length,
    drugs: inventory.drugs.length,
    drug_classes: inventory.drug_classes.length,
    tests: inventory.tests.length,
    treatments: inventory.treatments.length,
    formulas_cutoffs: inventory.formulas_cutoffs.length,
    mechanisms: inventory.mechanisms.length,
  };
}
