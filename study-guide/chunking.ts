import type { StepAOutput } from "../../machine/render_study_guide_html";

const MACHINE_STUDY_GUIDE_STEP_A_MAX_SLIDES = 6;
const MACHINE_STUDY_GUIDE_STEP_A_MAX_CHARS = 12_000;
const MACHINE_STUDY_GUIDE_STEP_A_SUMMARY_CHUNK_CHARS = 12_000;
const MACHINE_STUDY_GUIDE_STEP_A_SUMMARY_MAX_OUTPUT_TOKENS = 700;

type MachineSlideBlock = { n: number; page: number; text: string };

type StepAChunk = {
  startSlide: number;
  endSlide: number;
  text: string;
  slides: MachineSlideBlock[];
};

type StepAChunkExtractOutput = {
  lecture_title: string;
  chunk: { start_slide: number; end_slide: number };
  slides: StepAOutput["slides"];
};

type StepAExtractOutput = Pick<StepAOutput, "lecture_title" | "slides">;

type StepADerivedOutput = {
  raw_facts: StepAOutput["raw_facts"];
  buckets: StepAOutput["buckets"];
  discriminators: StepAOutput["discriminators"];
  exam_atoms: StepAOutput["exam_atoms"];
  abbrev_map: StepAOutput["abbrev_map"];
  source_spans: StepAOutput["source_spans"];
};

function formatStudyGuideSlideBlock(slide: MachineSlideBlock): string {
  const body = slide.text || "[NO TEXT]";
  return `Slide ${slide.n} (p.${slide.page}):\n${body}`;
}

export function buildStudyGuideStepAChunks(
  slides: MachineSlideBlock[],
  maxSlides = MACHINE_STUDY_GUIDE_STEP_A_MAX_SLIDES,
  maxChars = MACHINE_STUDY_GUIDE_STEP_A_MAX_CHARS,
): StepAChunk[] {
  const chunks: StepAChunk[] = [];
  let currentSlides: MachineSlideBlock[] = [];
  let currentParts: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (!currentSlides.length) return;
    const first = currentSlides[0];
    const last = currentSlides[currentSlides.length - 1];
    if (!first || !last) return;
    chunks.push({
      startSlide: first.n,
      endSlide: last.n,
      text: currentParts.join("\n\n"),
      slides: currentSlides,
    });
    currentSlides = [];
    currentParts = [];
    currentLength = 0;
  };

  for (const slide of slides) {
    const blockText = formatStudyGuideSlideBlock(slide);
    const separatorLength = currentParts.length ? 2 : 0;
    if (
      currentSlides.length &&
      (currentSlides.length >= maxSlides || currentLength + separatorLength + blockText.length > maxChars)
    ) {
      flush();
    }
    const nextSeparator = currentParts.length ? 2 : 0;
    currentSlides.push(slide);
    currentParts.push(blockText);
    currentLength += nextSeparator + blockText.length;
  }

  flush();
  return chunks;
}

export function mergeStepAChunks(chunks: StepAChunkExtractOutput[]): StepAExtractOutput {
  if (!chunks.length) {
    return { lecture_title: "Lecture", slides: [] };
  }
  const sortedChunks = [...chunks].sort((a, b) => {
    const aStart = Number.isFinite(a.chunk?.start_slide) ? a.chunk.start_slide : 0;
    const bStart = Number.isFinite(b.chunk?.start_slide) ? b.chunk.start_slide : 0;
    return aStart - bStart;
  });
  const firstChunk = sortedChunks[0];
  if (!firstChunk) {
    return { lecture_title: "Lecture", slides: [] };
  }
  const slides: StepAOutput["slides"] = [];
  const seen = new Set<number>();
  for (const chunk of sortedChunks) {
    const sortedSlides = [...(chunk.slides || [])].sort((a, b) => a.n - b.n);
    for (const slide of sortedSlides) {
      if (seen.has(slide.n)) {
        console.warn("[machine.studyGuide] Duplicate slide in Step A merge", { slide: slide.n });
        continue;
      }
      seen.add(slide.n);
      slides.push(slide);
    }
  }
  return {
    lecture_title: firstChunk.lecture_title || "Lecture",
    slides,
  };
}

function buildDefaultStepADerivedOutput(): StepADerivedOutput {
  return {
    raw_facts: [],
    buckets: {
      dx: [],
      pathophys: [],
      clinical: [],
      labs: [],
      imaging: [],
      treatment: [],
      complications: [],
      risk_factors: [],
      epidemiology: [],
      red_flags: [],
      buzzwords: [],
    },
    discriminators: [],
    exam_atoms: [],
    abbrev_map: {},
    source_spans: [],
  };
}

export function mergeStepAExtractAndDerived(
  stepAExtract: StepAExtractOutput,
  derived: StepADerivedOutput | null | undefined,
): StepAOutput {
  const safeDerived = derived ?? buildDefaultStepADerivedOutput();
  return {
    lecture_title: stepAExtract.lecture_title || "Lecture",
    slides: stepAExtract.slides || [],
    raw_facts: safeDerived.raw_facts,
    buckets: safeDerived.buckets,
    discriminators: safeDerived.discriminators,
    exam_atoms: safeDerived.exam_atoms,
    abbrev_map: safeDerived.abbrev_map,
    source_spans: safeDerived.source_spans,
  };
}

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

function buildStepASlideText(slide: StepAOutput["slides"][number]): string {
  const lines: string[] = [`Slide ${slide.n} (p.${slide.page})`];
  for (const section of slide.sections || []) {
    if (section.heading) lines.push(section.heading);
    for (const fact of section.facts || []) {
      if (fact?.text) lines.push(`- ${fact.text}`);
    }
  }
  return lines.join("\n").trim();
}

function buildStepASummaryChunks(stepA: StepAOutput, maxChars: number): string[] {
  const slideTexts = (stepA.slides || []).map(buildStepASlideText).filter(Boolean);
  const baseTexts = slideTexts.length
    ? slideTexts
    : normalizeStrings([...(stepA.raw_facts || []), ...(stepA.exam_atoms || [])]);
  if (!baseTexts.length) return [];
  const chunks: string[] = [];
  let current = "";
  for (const text of baseTexts) {
    const next = current ? `${current}\n\n${text}` : text;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = text;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function extractSummaryLines(raw: string): string[] {
  const lines = (raw || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length) return lines;
  return (raw || "").split(/[.;]\s+/).map((line) => line.trim()).filter(Boolean);
}

function trimBucket(values: string[] | undefined, limit: number): string[] {
  return normalizeStrings(values).slice(0, limit);
}

function trimAbbrevMap(map: Record<string, string> | undefined, limit: number): Record<string, string> {
  const entries = Object.entries(map || {}).filter(([key, value]) => key && value);
  return entries.slice(0, limit).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[key] = value;
    return acc;
  }, {});
}

function buildCondensedStepAFromSummaries(stepA: StepAOutput, summaries: string[]): StepAOutput {
  return {
    lecture_title: stepA.lecture_title,
    slides: [],
    raw_facts: summaries.slice(0, 80),
    buckets: {
      dx: trimBucket(stepA.buckets?.dx, 12),
      pathophys: trimBucket(stepA.buckets?.pathophys, 8),
      clinical: trimBucket(stepA.buckets?.clinical, 12),
      labs: trimBucket(stepA.buckets?.labs, 10),
      imaging: trimBucket(stepA.buckets?.imaging, 8),
      treatment: trimBucket(stepA.buckets?.treatment, 10),
      complications: trimBucket(stepA.buckets?.complications, 8),
      risk_factors: trimBucket(stepA.buckets?.risk_factors, 8),
      epidemiology: trimBucket(stepA.buckets?.epidemiology, 6),
      red_flags: trimBucket(stepA.buckets?.red_flags, 8),
      buzzwords: trimBucket(stepA.buckets?.buzzwords, 8),
    },
    discriminators: (stepA.discriminators || []).slice(0, 6).map((item) => ({
      topic: item.topic,
      signals: trimBucket(item.signals, 4),
      pitfalls: trimBucket(item.pitfalls, 3),
    })),
    exam_atoms: summaries.slice(0, 30),
    abbrev_map: trimAbbrevMap(stepA.abbrev_map, 30),
    source_spans: [],
  };
}

export async function condenseStepAForSynthesis(opts: {
  stepA: StepAOutput;
  callModel: (step: string, prompt: string, maxOutputTokens: number) => Promise<string>;
  maxChunkChars?: number;
  maxOutputTokens?: number;
}): Promise<{ stepA: StepAOutput; summaryLines: string[]; chunkCount: number; usedFallback: boolean }> {
  const chunkSize = Math.max(4000, opts.maxChunkChars || MACHINE_STUDY_GUIDE_STEP_A_SUMMARY_CHUNK_CHARS);
  const chunks = buildStepASummaryChunks(opts.stepA, chunkSize);
  const summaries: string[] = [];
  let usedFallback = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const prompt = [
      "Summarize the study guide source into 8-12 short bullet lines.",
      "Use ONLY the text provided. No external facts.",
      "Return plain text lines starting with '- '.",
      "",
      "SOURCE:",
      chunk,
    ].join("\n");
    try {
      const raw = await opts.callModel(
        `B-summary-${i + 1}`,
        prompt,
        opts.maxOutputTokens || MACHINE_STUDY_GUIDE_STEP_A_SUMMARY_MAX_OUTPUT_TOKENS,
      );
      summaries.push(...extractSummaryLines(raw));
    } catch {
      usedFallback = true;
    }
  }
  let unique = uniqueStrings(summaries);
  if (!unique.length) {
    usedFallback = true;
    unique = uniqueStrings([...(opts.stepA.exam_atoms || []), ...(opts.stepA.raw_facts || [])]);
  }
  return {
    stepA: buildCondensedStepAFromSummaries(opts.stepA, unique),
    summaryLines: unique,
    chunkCount: chunks.length,
    usedFallback,
  };
}
