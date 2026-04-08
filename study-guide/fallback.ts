import type { StepAOutput, StepBOutput } from "../../machine/render_study_guide_html";

const MACHINE_STUDY_GUIDE_STEP_A_MIN_CHARS = 800;

type MachineSlideBlock = { n: number; page: number; text: string };

type StepBPlan = {
  selected_exam_atoms: string[];
  section_counts: {
    high_yield_summary: number;
    one_page_last_minute_review: number;
    rapid_approach_table_rows: number;
    compare_topics: number;
    compare_rows_per_topic: number;
  };
  compare_topics: string[];
  atom_to_section_map: Array<{ atom: string; section: string }>;
  warnings?: string[];
};

function normalizeStrings(items: string[] | undefined | null): string[] {
  return (items || []).map((item) => (item || "").trim()).filter(Boolean);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (set.has(key)) continue;
    set.add(key);
    results.push(trimmed);
  }
  return results;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pickFirstN(items: string[], n: number): string[] {
  return items.slice(0, Math.max(0, n));
}

function classifyFallbackAtom(atom: string): string {
  const lower = (atom || "").toLowerCase();
  if (/(treat|therapy|management|tx|drug|medication|antibiotic)/.test(lower)) {
    return "one_page_last_minute_review";
  }
  if (
    /(lab|test|assay|panel|level|value|cutoff|threshold|titer|ratio|imaging|x-ray|ct|mri|ultrasound|scan)/.test(
      lower,
    ) ||
    /\d/.test(lower)
  ) {
    return "rapid_approach_table";
  }
  return "high_yield_summary";
}

export function buildFallbackPlanFromStepA(stepA: StepAOutput): StepBPlan {
  const examAtoms = normalizeStrings(stepA.exam_atoms);
  const bucketAtoms = uniqueStrings([
    ...normalizeStrings(stepA.buckets?.dx),
    ...normalizeStrings(stepA.buckets?.clinical),
    ...normalizeStrings(stepA.buckets?.labs),
    ...normalizeStrings(stepA.buckets?.treatment),
  ]);
  const selectedSource = examAtoms.length ? examAtoms : bucketAtoms;
  const selected_exam_atoms = pickFirstN(selectedSource, 18);

  const discriminatorTopics = uniqueStrings(
    normalizeStrings((stepA.discriminators || []).map((item) => item?.topic || "")),
  );
  let compareTopics = pickFirstN(discriminatorTopics, 3);
  if (!compareTopics.length) {
    compareTopics = pickFirstN(normalizeStrings(stepA.buckets?.dx), 3);
  }
  while (compareTopics.length < 3) {
    compareTopics.push(`Topic ${compareTopics.length + 1}`);
  }

  return {
    selected_exam_atoms,
    section_counts: {
      high_yield_summary: clamp(10, 8, 12),
      one_page_last_minute_review: clamp(16, 12, 18),
      rapid_approach_table_rows: clamp(14, 10, 18),
      compare_topics: clamp(3, 2, 4),
      compare_rows_per_topic: clamp(5, 4, 7),
    },
    compare_topics: compareTopics,
    atom_to_section_map: selected_exam_atoms.map((atom) => ({
      atom,
      section: classifyFallbackAtom(atom),
    })),
    warnings: ["fallback_plan_used"],
  };
}

export function assessStepAQuality(
  stepA: StepAOutput,
  slides: MachineSlideBlock[],
  stepACharCount: number,
): { ok: true } | { ok: false; reason: string; message: string } {
  if (stepACharCount < MACHINE_STUDY_GUIDE_STEP_A_MIN_CHARS) {
    return {
      ok: false,
      reason: "step_a_too_small",
      message: "Step A extraction is too small. Please upload a clearer TXT or re-run OCR.",
    };
  }
  const slideCount = slides.length;
  if (slideCount) {
    const lowTextSlides = slides.filter((slide) => {
      const text = (slide.text || "").trim();
      return !text || text === "[NO TEXT]" || text.length < 30;
    }).length;
    if (lowTextSlides / slideCount >= 0.7) {
      return {
        ok: false,
        reason: "ocr_failure",
        message: "The source appears to be OCR-empty. Re-run OCR or upload a higher-quality PDF.",
      };
    }
  }
  const rawFacts = normalizeStrings(stepA.raw_facts);
  const examAtoms = normalizeStrings(stepA.exam_atoms);
  if (rawFacts.length < 3 && examAtoms.length < 3) {
    return {
      ok: false,
      reason: "step_a_sparse",
      message: "Step A extraction is too sparse. Verify the source TXT contains real lecture text.",
    };
  }
  return { ok: true };
}

function shortenWords(text: string, maxWords: number): string {
  const words = (text || "").split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}

function fillToCount(items: string[], count: number, maxWords: number): string[] {
  const cleaned = normalizeStrings(items);
  const source = cleaned.length ? cleaned : ["Review source text"];
  const results: string[] = [];
  let idx = 0;
  while (results.length < count) {
    results.push(shortenWords(source[idx % source.length], maxWords));
    idx += 1;
  }
  return results;
}

export function buildFallbackStepBOutput(stepA: StepAOutput, opts?: { downloadUrl?: string }): StepBOutput {
  const baseItems = uniqueStrings([...(stepA.exam_atoms || []), ...(stepA.raw_facts || [])]);
  const highYield = fillToCount(baseItems, 8, 16);
  const onePage = fillToCount(baseItems, 12, 14);
  const rapidSource = uniqueStrings([
    ...normalizeStrings(stepA.buckets?.labs),
    ...normalizeStrings(stepA.buckets?.imaging),
    ...normalizeStrings(stepA.buckets?.clinical),
    ...normalizeStrings(stepA.buckets?.dx),
  ]);
  const rapidItems = rapidSource.length ? rapidSource : baseItems;
  const rapidRows = Array.from({ length: 10 }, (_, i) => {
    const value = rapidItems[i % rapidItems.length] || "Review source text";
    return {
      clue: shortenWords(value, 10),
      think_of: shortenWords(value, 6),
      why: shortenWords(value, 14),
      confirm: "Review source slide",
    };
  });
  const supplemental = opts?.downloadUrl ? [`Download source TXT: ${opts.downloadUrl}`] : [];
  return {
    high_yield_summary: highYield,
    rapid_approach_table: rapidRows,
    one_page_last_minute_review: onePage,
    compare_differential: [],
    quant_cutoffs: [],
    pitfalls: [],
    glossary: [],
    supplemental_glue: supplemental,
  };
}

export async function enforceStepBSynthesisMinimums(opts: {
  stepA: StepAOutput;
  stepB: StepBOutput;
  plan: StepBPlan;
  callModel: (step: string, prompt: string, maxOutputTokens: number) => Promise<string>;
}): Promise<{ stepB: StepBOutput; failures: unknown[]; hadRewrite: boolean; hadRedraft: boolean }> {
  void opts.plan;
  void opts.callModel;
  return {
    stepB: opts.stepB,
    failures: [],
    hadRewrite: false,
    hadRedraft: false,
  };
}
